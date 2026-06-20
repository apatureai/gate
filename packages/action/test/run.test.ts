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
    getCurrentHeadSha: vi.fn(async () => "abc123"),
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

  it("removes auth and bypass secret names before handing a fork PR to the engine", async () => {
    const engine = engineReturning({ status: "completed", result: golden, jobId: "j" });
    const d = deps(engine);
    const config: NormalizedDesignReviewConfig = {
      ...DEFAULT_CONFIG,
      preview: {
        ...DEFAULT_CONFIG.preview,
        protectionBypassSecretName: "BYPASS_SECRET",
        authStateSecretName: "AUTH_STATE_SECRET",
      },
    };

    await runAction(
      config,
      { previewUrl: "https://preview.example.com", previewCommand: null },
      ctx({ isFork: true }),
      d,
    );

    const request = (engine.review as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(request.config.preview.protectionBypassSecretName).toBeNull();
    expect(request.config.preview.authStateSecretName).toBeNull();
    expect(config.preview.protectionBypassSecretName).toBe("BYPASS_SECRET");
  });

  it("a timed-out review posts a neutral Check Run, no comment, PR not failed", async () => {
    const engine = engineReturning({ status: "timed_out", reason: "review_timed_out", jobId: "j" });
    const d = deps(engine);
    const outcome = await runAction(DEFAULT_CONFIG, { previewUrl: "https://preview.example.com", previewCommand: null }, ctx(), d);
    expect(outcome.conclusion).toBe("neutral");
    expect(outcome.commentAction).toBeUndefined();
  });

  it("discards a completed review when a newer PR head exists at publish time", async () => {
    const engine = engineReturning({ status: "completed", result: golden, jobId: "j" });
    const d = deps(engine);
    d.getCurrentHeadSha.mockResolvedValue("newer");

    const outcome = await runAction(
      DEFAULT_CONFIG,
      { previewUrl: "https://preview.example.com", previewCommand: null },
      ctx(),
      d,
    );

    expect(outcome.status).toBe("stale_discarded");
    expect(d.comments.createComment).not.toHaveBeenCalled();
    expect(d.publishCheckRun).not.toHaveBeenCalled();
  });

  it("posts a neutral Check Run (never crashes) when the engine throws", async () => {
    const engine: JudgmentEngineClient = {
      review: vi.fn(async () => {
        throw new Error("engine 503");
      }),
      cancel: vi.fn(async () => {}),
    };
    const d = deps(engine);
    const outcome = await runAction(DEFAULT_CONFIG, { previewUrl: "https://preview.example.com", previewCommand: null }, ctx(), d);
    expect(outcome.status).toBe("engine_error");
    expect(outcome.conclusion).toBe("neutral");
    expect(d._published[0]?.conclusion).toBe("neutral");
    expect(d.comments.createComment).not.toHaveBeenCalled();
  });

  it("blocks only under gate:blockers on a blocked grade", async () => {
    const engine = engineReturning({ status: "completed", result: { ...golden, grade: "blocked" }, jobId: "j" });
    const d = deps(engine);
    const outcome = await runAction(configBlockers, { previewUrl: "https://preview.example.com", previewCommand: null }, ctx(), d);
    expect(outcome.conclusion).toBe("failure");
  });
});

describe("runAction local-serve (#70 Part 4)", () => {
  const forkPreviewOn: NormalizedDesignReviewConfig = {
    ...DEFAULT_CONFIG,
    preview: { ...DEFAULT_CONFIG.preview, forkPreview: true },
  };
  function fakeServer(output = "") {
    const stop = vi.fn(async () => {});
    const startLocalServer = vi.fn(async (_cmd: string, opts: { url: string }) => ({
      ok: true as const,
      server: { url: opts.url, pid: 4242, output: () => output, stop },
    }));
    return { startLocalServer, stop };
  }

  it("starts + supervises the local server, hands off, and tears down (same-repo)", async () => {
    const engine = engineReturning({ status: "completed", result: golden, jobId: "j" });
    const { startLocalServer, stop } = fakeServer();
    const d = { ...deps(engine), startLocalServer };
    const outcome = await runAction(DEFAULT_CONFIG, { previewUrl: null, previewCommand: "npm run dev" }, ctx(), d);

    expect(startLocalServer).toHaveBeenCalledOnce();
    expect(outcome.status).toBe("reviewed");
    // engine got the local URL, and the server was torn down.
    expect((engine.review as ReturnType<typeof vi.fn>).mock.calls[0][0].preview.url).toContain("127.0.0.1");
    expect(stop).toHaveBeenCalledOnce();
  });

  it("does NOT spawn when a higher-priority source resolved (explicit URL wins)", async () => {
    const engine = engineReturning({ status: "completed", result: golden, jobId: "j" });
    const { startLocalServer } = fakeServer();
    const d = { ...deps(engine), startLocalServer };
    await runAction(DEFAULT_CONFIG, { previewUrl: "https://preview.example.com", previewCommand: "npm run dev" }, ctx(), d);
    expect(startLocalServer).not.toHaveBeenCalled();
  });

  it("skips a fork PR by default (no spawn, no engine call), neutral Check Run", async () => {
    const engine = engineReturning({ status: "completed", result: golden, jobId: "j" });
    const { startLocalServer } = fakeServer();
    const d = { ...deps(engine), startLocalServer };
    const outcome = await runAction(DEFAULT_CONFIG, { previewUrl: null, previewCommand: "npm run dev" }, ctx({ isFork: true }), d);

    expect(outcome.status).toBe("no_preview");
    expect(startLocalServer).not.toHaveBeenCalled();
    expect(engine.review).not.toHaveBeenCalled();
    expect(d._published[0]?.title).toContain("fork");
  });

  it("runs a fork PR when fork_preview is enabled", async () => {
    const engine = engineReturning({ status: "completed", result: golden, jobId: "j" });
    const { startLocalServer } = fakeServer();
    const d = { ...deps(engine), startLocalServer };
    const outcome = await runAction(forkPreviewOn, { previewUrl: null, previewCommand: "npm run dev" }, ctx({ isFork: true }), d);

    expect(startLocalServer).toHaveBeenCalledOnce();
    expect(outcome.status).toBe("reviewed");
  });

  it("attaches previewBuildFacts (U1) from the boot log to the engine request", async () => {
    const engine = engineReturning({ status: "completed", result: golden, jobId: "j" });
    const { startLocalServer } = fakeServer("Warning: Text content did not match. Hydration failed...");
    const d = { ...deps(engine), startLocalServer };
    await runAction(DEFAULT_CONFIG, { previewUrl: null, previewCommand: "npm run dev" }, ctx(), d);
    const req = (engine.review as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(req.previewBuildFacts?.[0]?.kind).toBe("hydration");
  });

  it("a not-ready preview server => neutral not-reviewed, never an engine call", async () => {
    const engine = engineReturning({ status: "completed", result: golden, jobId: "j" });
    const startLocalServer = vi.fn(async () => ({ ok: false as const, reason: "not_ready" as const, detail: "x", tail: "boot log" }));
    const d = { ...deps(engine), startLocalServer };
    const outcome = await runAction(DEFAULT_CONFIG, { previewUrl: null, previewCommand: "npm run dev" }, ctx(), d);

    expect(outcome.status).toBe("no_preview");
    expect(outcome.notReviewed).toBe("not_ready");
    expect(engine.review).not.toHaveBeenCalled();
    expect(d._published[0]?.conclusion).toBe("neutral");
  });
});
