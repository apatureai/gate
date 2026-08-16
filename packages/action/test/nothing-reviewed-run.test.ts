import { DEFAULT_CONFIG } from "@gate/config";
import type { CheckRun, GitHubCommentsApi } from "@gate/delivery";
import { canonicalReviewIdentity, type JudgmentEngineClient } from "@gate/engine";
import { loadGoldenReviewResult, type GateReviewResult } from "@gate/types";
import { describe, expect, it, vi } from "vitest";
import { runAction } from "../src/run.js";

/**
 * A whole Action run against an engine that reviewed nothing (verdict#165).
 *
 * The result below is the shape a real capture failure returns: a model client
 * WAS configured and called, so `provenance.model_backed` is an honest `true`,
 * but it was called about zero pages. Nothing survives to grade, so the grade
 * floors to `ship` and the payload is field-for-field a clean review. Before
 * coverage, this published `conclusion: "success"`, `title: "Ship"`.
 *
 * The run must end visibly ungraded at every surface: the returned status, the
 * Check Run, and the sticky comment.
 */
const golden = loadGoldenReviewResult();
const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";

const nothingReviewed: GateReviewResult = {
  ...golden,
  grade: "ship",
  overall: "",
  findings: [],
  artifacts: { annotatedScreenshots: [] },
  notReviewed: ["no captured routes"],
  coverage: {
    routesRequested: ["/pricing", "/checkout"],
    routesReviewed: [],
    viewportsRequested: ["mobile", "tablet", "desktop"],
    viewportsReviewed: [],
  },
  provenance: {
    model_backed: true,
    source: "model",
    engine: "verdict-http",
    model: "qwen3-vl",
    detail: "qwen3-vl was called for this review",
  },
};

/** The same engine, having actually reached the pages: a real clean partial. */
const cleanPartial: GateReviewResult = {
  ...nothingReviewed,
  overall: "No issues found on the routes that were reachable.",
  notReviewed: ["route /checkout (no preview deployment matched the head SHA)"],
  coverage: {
    routesRequested: ["/pricing", "/checkout"],
    routesReviewed: ["/pricing"],
    viewportsRequested: ["mobile", "tablet", "desktop"],
    viewportsReviewed: ["mobile", "tablet", "desktop"],
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

describe("an Action run whose engine reviewed nothing", () => {
  it("does not call itself reviewed", async () => {
    const { outcome } = await run(nothingReviewed);
    expect(outcome.status).toBe("nothing_reviewed");
    expect(outcome.coverage).toBe("nothing");
    // The engine's judgment stamp is honest and unhelpful on its own: a model
    // WAS called. Coverage is the only field that catches this run.
    expect(outcome.judgment).toBe("model_backed");
  });

  it("does not publish a green check for a review that touched nothing", async () => {
    const { outcome, published } = await run(nothingReviewed);
    expect(outcome.conclusion).toBe("neutral");
    expect(published[0]?.conclusion).toBe("neutral");
    expect(published[0]?.title).toBe("Nothing reviewed");
    expect(published[0]?.summary).toContain("**No grade.**");
    expect(published[0]?.summary).toContain("no captured routes");
  });

  it("posts a comment a reader cannot mistake for a passing review", async () => {
    const { bodies } = await run(nothingReviewed);
    const body = bodies[0] ?? "";
    expect(body).toContain("Nothing reviewed");
    expect(body).toContain("no design review");
    expect(body).not.toContain("✅");
  });

  it("stays neutral under gate: blockers as well", async () => {
    const { outcome } = await run({ ...nothingReviewed, grade: "blocked" }, "blockers");
    expect(outcome.conclusion).toBe("neutral");
  });

  it("still passes a genuinely clean PARTIAL review, and says what it skipped", async () => {
    // The regression rail, end to end: same engine, same zero findings, same
    // non-empty notReviewed. The only difference is that this one reviewed
    // something, and it must stay green.
    const { outcome, published, bodies } = await run(cleanPartial, "blockers");
    expect(outcome.status).toBe("reviewed");
    expect(outcome.coverage).toBe("partial");
    expect(outcome.conclusion).toBe("success");
    expect(published[0]?.title).toBe("Ship");
    expect(published[0]?.summary).toContain("1 of 2 route(s) reviewed");
    expect(published[0]?.summary).toContain("/checkout");
    expect(bodies[0]).toContain("Not reviewed");
  });
});
