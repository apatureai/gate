import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runAction, type ActionRunContext } from "@gate/action";
import { DEFAULT_CONFIG } from "@gate/config";
import type { CheckRun, GitHubCommentsApi, IssueComment } from "@gate/delivery";
import { createHttpEngineTransport, createJudgmentEngineClient } from "@gate/engine";
import { loadGoldenReviewResult } from "@gate/types";
import type { GateReviewResult } from "@gate/types";
import { describe, expect, it } from "vitest";

/**
 * Golden-path demo-as-test (#42, TRD §14): the full Action path against the
 * MOCK engine — break -> annotated review under the 90s budget -> fix flips the
 * Check Run green. The scheduled live-pipeline run is an ops wiring step.
 */
const REVIEW_BUDGET_MS = 90_000;
const golden = loadGoldenReviewResult();
const BREAK_SHA = "0123456789abcdef0123456789abcdef01234567";
const FIXED_SHA = "89abcdef0123456789abcdef0123456789abcdef";

function mockEngine(result: GateReviewResult) {
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    if (url.endsWith("/jobs") && init.method === "POST") {
      return new Response(JSON.stringify({ jobId: "job_1" }), { status: 202 });
    }
    return new Response(JSON.stringify({ jobId: "job_1", state: "completed", result }), {
      status: 200,
      headers: { "x-schema-version": "1" },
    });
  }) as unknown as typeof fetch;
  return createJudgmentEngineClient(createHttpEngineTransport({ baseUrl: "https://engine.test", fetchImpl }));
}

function inMemoryGitHub() {
  const store: IssueComment[] = [];
  let id = 1;
  const checkRuns: CheckRun[] = [];
  const comments: GitHubCommentsApi = {
    listComments: async () => store.map((c) => ({ ...c })),
    createComment: async (body) => {
      const c = { id, nodeId: `n${id}`, body };
      id += 1;
      store.push(c);
      return c;
    },
    updateComment: async (cid, body, expected) => {
      const c = store.find((x) => x.id === cid);
      if (!c || c.nodeId !== expected) return { updated: false };
      c.body = body;
      return { updated: true };
    },
  };
  return {
    comments,
    getCurrentHeadSha: async (headSha: string) => headSha,
    publishCheckRun: async (r: CheckRun) => void checkRuns.push(r),
    store,
    checkRuns,
  };
}

const ctx: ActionRunContext = {
  installationId: "acme/web",
  repository: { owner: "acme", name: "web", defaultBranch: "main" },
  pullRequest: { number: 7, headSha: BREAK_SHA, baseSha: "main0", title: "Tweak pricing", body: null },
  isFork: false,
  previewComments: [],
};

describe("golden-path demo smoke test", () => {
  it("the break PR gets an annotated, screenshot-grounded review within the 90s budget", async () => {
    expect(golden.findings.length).toBeGreaterThan(0);
    expect(golden.artifacts.annotatedScreenshots.length).toBeGreaterThan(0); // screenshot-grounded

    const gh = inMemoryGitHub();
    const start = Date.now();
    const outcome = await runAction(
      DEFAULT_CONFIG,
      { previewUrl: "https://acme-web-pr7.vercel.app", previewCommand: null },
      ctx,
      {
        engine: mockEngine(golden),
        comments: gh.comments,
        getCurrentHeadSha: () => gh.getCurrentHeadSha(ctx.pullRequest.headSha),
        publishCheckRun: gh.publishCheckRun,
        runUrl: "https://gate.app/runs/1",
      },
    );
    const elapsed = Date.now() - start;

    expect(outcome.status).toBe("reviewed");
    expect(elapsed).toBeLessThan(REVIEW_BUDGET_MS);
    expect(gh.store[0]?.body).toContain(golden.findings[0]!.title); // annotated finding in the comment
  });

  it("after the fix, a re-run flips the Check Run to passing", async () => {
    const shipped: GateReviewResult = { ...golden, grade: "ship", findings: [], artifacts: { annotatedScreenshots: [] } };
    const gh = inMemoryGitHub();
    const outcome = await runAction(
      DEFAULT_CONFIG,
      { previewUrl: "https://acme-web-pr7.vercel.app", previewCommand: null },
      { ...ctx, pullRequest: { ...ctx.pullRequest, headSha: FIXED_SHA } },
      {
        engine: mockEngine(shipped),
        comments: gh.comments,
        getCurrentHeadSha: () => gh.getCurrentHeadSha(FIXED_SHA),
        publishCheckRun: gh.publishCheckRun,
      },
    );
    expect(outcome.conclusion).toBe("success");
    expect(gh.checkRuns.at(-1)?.conclusion).toBe("success");
  });

  it("the golden-path runbook documents the demo + scheduled smoke test", () => {
    const doc = readFileSync(fileURLToPath(new URL("../../../docs/golden-path-demo.md", import.meta.url)), "utf8");
    expect(doc).toContain("under 90 seconds");
    expect(doc.toLowerCase()).toContain("scheduled");
  });
});
