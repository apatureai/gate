import { DEFAULT_CONFIG } from "@gate/config";
import type { CheckRun, GitHubCommentsApi } from "@gate/delivery";
import { canonicalReviewIdentity, type JudgmentEngineClient } from "@gate/engine";
import { loadGoldenReviewResult, type GateReviewResult } from "@gate/types";
import { describe, expect, it, vi } from "vitest";
import { runAction } from "../src/run.js";

/**
 * A whole Action run against an engine with no model configured.
 *
 * The result below is the shape a real `verdict --model mock` returns: a real
 * capture, real measurements, a grade of `ship` that nothing stands behind, and
 * the engine saying so in `provenance`. The run must end visibly ungraded at
 * every surface a person or a program looks at: the returned status, the Check
 * Run, and the sticky comment.
 */
const golden = loadGoldenReviewResult();
const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";

const unjudged: GateReviewResult = {
  ...golden,
  grade: "ship",
  overall: "[verdict] no model judged this page: verdict ran this review with the mock client.",
  findings: [],
  notReviewed: ["[verdict] no model judged this page: verdict ran this review with the mock client."],
  provenance: {
    model_backed: false,
    source: "canned",
    engine: "verdict-http",
    model: null,
    detail: "verdict ran this review with the mock client",
  },
};

function harness(result: GateReviewResult) {
  const engine: JudgmentEngineClient = {
    review: vi.fn(async (reviewCtx) => ({
      status: "completed" as const,
      result,
      jobId: "job_1",
      reviewIdentity: canonicalReviewIdentity(reviewCtx),
    })),
    cancel: vi.fn(async () => {}),
  };
  const bodies: string[] = [];
  const comments: GitHubCommentsApi = {
    listComments: vi.fn(async () => []),
    createComment: vi.fn(async (body) => {
      bodies.push(body);
      return { id: 1, nodeId: "n1", body };
    }),
    updateComment: vi.fn(async () => ({ updated: true })),
  };
  const published: CheckRun[] = [];
  return {
    bodies,
    published,
    deps: {
      engine,
      comments,
      getCurrentHeadSha: vi.fn(async () => HEAD_SHA),
      publishCheckRun: vi.fn(async (run: CheckRun) => void published.push(run)),
    },
  };
}

const run = async (result: GateReviewResult, gate: "none" | "blockers" = "none") => {
  const h = harness(result);
  const config = { ...DEFAULT_CONFIG, rules: { ...DEFAULT_CONFIG.rules, gate } };
  const outcome = await runAction(
    config,
    { previewUrl: "https://preview.example.com", previewCommand: null },
    {
      installationId: "acme/web",
      repository: { owner: "acme", name: "web", defaultBranch: "main" },
      pullRequest: { number: 42, headSha: HEAD_SHA, baseSha: "def456", title: "Redesign", body: null },
      isFork: false,
      previewComments: [],
    },
    h.deps,
  );
  return { outcome, ...h };
};

describe("an Action run against an engine with no model", () => {
  it("does not call itself reviewed", async () => {
    const { outcome } = await run(unjudged);
    expect(outcome.status).toBe("not_judged");
    expect(outcome.judgment).toBe("unjudged");
  });

  it("does not publish a green check for a page nothing looked at", async () => {
    const { outcome, published } = await run(unjudged);
    expect(outcome.conclusion).toBe("neutral");
    expect(published[0]?.conclusion).toBe("neutral");
    expect(published[0]?.title).toBe("Not judged");
  });

  it("posts a comment a reader cannot mistake for a passing review", async () => {
    const { bodies } = await run(unjudged);
    const body = bodies[0] ?? "";
    expect(body).toContain("Not judged");
    expect(body).not.toContain("✅");
    expect(body).toContain("no design review");
  });

  it("stays neutral under gate: blockers as well", async () => {
    const { outcome } = await run({ ...unjudged, grade: "blocked" }, "blockers");
    expect(outcome.conclusion).toBe("neutral");
  });

  it("still reports a judged result as a review", async () => {
    const judged: GateReviewResult = {
      ...golden,
      provenance: {
        model_backed: true,
        source: "model",
        engine: "verdict-http",
        model: "qwen3-vl-plus",
        detail: "a vision model judged the capture",
      },
    };
    const { outcome, published } = await run(judged);
    expect(outcome.status).toBe("reviewed");
    expect(outcome.judgment).toBe("model_backed");
    expect(published[0]?.title).toBe("Needs work");
  });
});
