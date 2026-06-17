import { DEFAULT_CONFIG } from "@gate/config";
import type { CheckRun, GitHubCommentsApi } from "@gate/delivery";
import type { JudgmentEngineClient } from "@gate/engine";
import { loadGoldenReviewResult } from "@gate/types";
import type { NormalizedDesignReviewConfig } from "@gate/types";
import { describe, expect, it, vi } from "vitest";
import { type ActionRunContext, runAction } from "../src/run.js";

const golden = loadGoldenReviewResult();

function ctx(overrides: Partial<ActionRunContext> = {}): ActionRunContext {
  return {
    installationId: "acme/web",
    repository: { owner: "acme", name: "web", defaultBranch: "main" },
    pullRequest: { number: 42, headSha: "abc123", baseSha: "def456", title: "Redesign", body: null },
    isFork: false,
    previewComments: [],
    ...overrides,
  };
}

function engineReturning(outcome: Awaited<ReturnType<JudgmentEngineClient["review"]>>): JudgmentEngineClient {
  return { review: vi.fn(async () => outcome), cancel: vi.fn(async () => {}) };
}

function deps(engine: JudgmentEngineClient) {
  const comments: GitHubCommentsApi = {
    listComments: vi.fn(async () => []),
    createComment: vi.fn(async (body) => ({ id: 1, nodeId: "n1", body })),
    updateComment: vi.fn(async () => ({ updated: true })),
  };
  const published: CheckRun[] = [];
  return {
    engine,
    comments,
    publishCheckRun: vi.fn(async (run: CheckRun) => void published.push(run)),
    runUrl: "https://gate.app/runs/run_1",
    _published: published,
  };
}

const configBlockers: NormalizedDesignReviewConfig = {
  ...DEFAULT_CONFIG,
  rules: { ...DEFAULT_CONFIG.rules, gate: "blockers" },
};

describe("runAction", () => {
  it("reviews via explicit URL, posts the sticky comment and Check Run", async () => {
    const engine = engineReturning({ status: "completed", result: golden, jobId: "j" });
    const d = deps(engine);
    const outcome = await runAction(DEFAULT_CONFIG, { previewUrl: "https://preview.example.com", previewCommand: null }, ctx(), d);

    expect(outcome.status).toBe("reviewed");
    expect(outcome.commentAction).toBe("created");
    expect(d.publishCheckRun).toHaveBeenCalledOnce();
    expect(d._published[0]?.name).toBe("Apature Gate");
    // The engine was handed the explicit, verified URL.
    expect((engine.review as ReturnType<typeof vi.fn>).mock.calls[0][0].preview.url).toBe("https://preview.example.com/");
  });

  it("skips with a neutral Check Run and no comment when no preview is found", async () => {
    const engine = engineReturning({ status: "completed", result: golden, jobId: "j" });
    const d = deps(engine);
    const outcome = await runAction(DEFAULT_CONFIG, { previewUrl: null, previewCommand: null }, ctx(), d);

    expect(outcome.status).toBe("no_preview");
    expect(outcome.conclusion).toBe("neutral");
    expect(engine.review).not.toHaveBeenCalled();
    expect(d.comments.createComment).not.toHaveBeenCalled();
    expect(d._published[0]?.conclusion).toBe("neutral");
  });

  it("does not review when the preview source is unverified", async () => {
    const engine = engineReturning({ status: "completed", result: golden, jobId: "j" });
    const d = deps(engine);
    // provider vercel but URL host is off-domain -> handoff verification fails
    const outcome = await runAction(
      DEFAULT_CONFIG,
      { previewUrl: null, previewCommand: null },
      ctx({ previewComments: [{ author: "vercel[bot]", body: "see https://evil.example.com" }] }),
      d,
    );
    expect(outcome.status).toBe("no_preview"); // off-domain isn't even resolved by #8
    expect(engine.review).not.toHaveBeenCalled();
  });

  it("a timed-out review posts a neutral Check Run, no comment, PR not failed", async () => {
    const engine = engineReturning({ status: "timed_out", reason: "review_timed_out", jobId: "j" });
    const d = deps(engine);
    const outcome = await runAction(DEFAULT_CONFIG, { previewUrl: "https://preview.example.com", previewCommand: null }, ctx(), d);
    expect(outcome.conclusion).toBe("neutral");
    expect(outcome.commentAction).toBeUndefined();
  });

  it("blocks only under gate:blockers on a blocked grade", async () => {
    const engine = engineReturning({ status: "completed", result: { ...golden, grade: "blocked" }, jobId: "j" });
    const d = deps(engine);
    const outcome = await runAction(configBlockers, { previewUrl: "https://preview.example.com", previewCommand: null }, ctx(), d);
    expect(outcome.conclusion).toBe("failure");
  });
});
