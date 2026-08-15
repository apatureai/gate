import { DEFAULT_CONFIG } from "@gate/config";
import type { CheckRun, GitHubCommentsApi } from "@gate/delivery";
import {
  canonicalReviewIdentity,
  EngineIdempotencyConflictError,
  EngineJobError,
  type JudgmentEngineClient,
  type PollOutcome,
} from "@gate/engine";
import { loadGoldenReviewResult } from "@gate/types";
import type { NormalizedDesignReviewConfig } from "@gate/types";
import { describe, expect, it, vi } from "vitest";
import { type ActionRunContext, runAction } from "../src/run.js";

const golden = loadGoldenReviewResult();
const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";

function ctx(overrides: Partial<ActionRunContext> = {}): ActionRunContext {
  return {
    installationId: "acme/web",
    repository: { owner: "acme", name: "web", defaultBranch: "main" },
    pullRequest: { number: 42, headSha: HEAD_SHA, baseSha: "def456", title: "Redesign", body: null },
    isFork: false,
    previewComments: [],
    ...overrides,
  };
}

function engineReturning(outcome: PollOutcome): JudgmentEngineClient {
  return {
    review: vi.fn(async (reviewCtx) => ({
      ...outcome,
      reviewIdentity: canonicalReviewIdentity(reviewCtx),
    })),
    cancel: vi.fn(async () => {}),
  };
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
    getCurrentHeadSha: vi.fn(async () => HEAD_SHA),
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

  it("fails closed before publication when the engine outcome is bound to another repository", async () => {
    const engine = engineReturning({ status: "completed", result: golden, jobId: "j" });
    (engine.review as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => ({
      status: "completed",
      result: golden,
      jobId: "j",
      reviewIdentity: {
        repositoryOwner: "acme",
        repositoryName: "other",
        prNumber: 42,
        headSha: HEAD_SHA,
      },
    }));
    const d = deps(engine);

    const outcome = await runAction(
      DEFAULT_CONFIG,
      { previewUrl: "https://preview.example.com", previewCommand: null },
      ctx(),
      d,
    );

    expect(outcome.status).toBe("engine_error");
    expect(outcome.conclusion).toBe("neutral");
    expect(d.comments.createComment).not.toHaveBeenCalled();
    expect(d._published[0]?.conclusion).toBe("neutral");
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

  it("surfaces a secret-scrubbed, fenced tail of the command output on the failure Check Run (#78)", async () => {
    const engine = engineReturning({ status: "completed", result: golden, jobId: "j" });
    const tail = "build failed\nAPI_KEY=s3cr3tLeakedValue\nstack trace here";
    const startLocalServer = vi.fn(async () => ({ ok: false as const, reason: "early_exit" as const, detail: "x", tail }));
    const d = { ...deps(engine), startLocalServer };
    await runAction(DEFAULT_CONFIG, { previewUrl: null, previewCommand: "npm run dev" }, ctx(), d);

    const summary = d._published[0]?.summary ?? "";
    expect(summary).toContain("```"); // fenced
    expect(summary).toContain("secrets scrubbed");
    expect(summary).toContain("[REDACTED secret]");
    expect(summary).not.toContain("s3cr3tLeakedValue"); // the secret never reaches the PR
    expect(summary).toContain("build failed"); // ordinary output is preserved for DX
  });
});

/**
 * What the operator sees when the engine says no.
 *
 * The bare `catch {}` this replaces bound nothing and logged nothing, so
 * `engine submit failed: 401 (signature_mismatch)` was constructed, thrown, and
 * discarded one line before the handler published "temporarily unavailable ...
 * Gate will retry". A wrong shared secret is the single most likely installer
 * mistake and the least likely condition to clear on its own, so that Check Run
 * was a promise that could never come true.
 */
describe("runAction engine-failure reporting", () => {
  const rejecting = (err: unknown): JudgmentEngineClient => ({
    review: vi.fn(async () => {
      throw err;
    }),
    cancel: vi.fn(async () => {}),
  });

  async function publishedFor(err: unknown) {
    const d = deps(rejecting(err));
    const outcome = await runAction(
      DEFAULT_CONFIG,
      { previewUrl: "https://preview.example.com", previewCommand: null },
      ctx(),
      d,
    );
    return { outcome, run: d._published[0] };
  }

  it("names the engine's own code on the Check Run for a wrong shared secret", async () => {
    // The literal error a real critique service returns for a mismatched
    // GATE_ENGINE_HMAC_SECRET, produced by createHttpEngineTransport.
    const { outcome, run } = await publishedFor(
      new EngineJobError("engine submit failed: 401 (signature_mismatch)", {
        code: "signature_mismatch",
        status: 401,
      }),
    );

    expect(outcome.status).toBe("engine_rejected");
    expect(outcome.conclusion).toBe("neutral");
    expect(run?.title).toBe("Review not submitted");
    expect(run?.summary).toContain("HTTP 401");
    expect(run?.summary).toContain("signature_mismatch");
    expect(run?.summary).toContain("GATE_ENGINE_HMAC_SECRET");
    // The false promise, gone: nothing about the next push is different.
    expect(run?.summary).not.toContain("temporarily unavailable");
    expect(run?.summary).not.toContain("Gate will retry");
    expect(run?.summary).toContain("does not clear by itself");
  });

  it("does not publish a comment, and never fails the PR, on a rejection", async () => {
    const d = deps(
      rejecting(
        new EngineJobError("engine submit failed: 401 (signature_mismatch)", {
          code: "signature_mismatch",
          status: 401,
        }),
      ),
    );
    const outcome = await runAction(
      configBlockers,
      { previewUrl: "https://preview.example.com", previewCommand: null },
      ctx(),
      d,
    );
    expect(outcome.conclusion).toBe("neutral");
    expect(d.comments.createComment).not.toHaveBeenCalled();
  });

  it("gives an idempotency conflict its own Check Run and its own remedy", async () => {
    const { outcome, run } = await publishedFor(
      new EngineIdempotencyConflictError(
        "engine submit conflict: idempotency_conflict (the idempotency key is already in use by a different request)",
        "idempotency_conflict",
      ),
    );

    expect(outcome.status).toBe("idempotency_conflict");
    expect(outcome.conclusion).toBe("neutral");
    expect(run?.title).toBe("Review not submitted (duplicate key)");
    expect(run?.summary).toContain("idempotency_conflict");
    // The condition is permanent until the head SHA changes, so the remedy is a
    // push, not a wait.
    expect(run?.summary).toContain("preview URL");
    expect(run?.summary).toContain("Push a commit");
    expect(run?.summary).not.toContain("Gate will retry");
  });

  it("still calls a real outage an outage, and still promises the retry it will make", async () => {
    const { outcome, run } = await publishedFor(new Error("fetch failed"));
    expect(outcome.status).toBe("engine_error");
    expect(run?.title).toBe("Review unavailable");
    expect(run?.summary).toContain("Gate will retry");
  });

  it("reports a 5xx as an outage, not as a rejection", async () => {
    const { outcome } = await publishedFor(
      new EngineJobError("engine submit failed: 500 (internal)", { code: "internal", status: 500 }),
    );
    expect(outcome.status).toBe("engine_error");
  });

  it("logs the engine's message for the Action log, not only the Check Run", async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
    try {
      await publishedFor(
        new EngineJobError("engine submit failed: 401 (signature_mismatch)", {
          code: "signature_mismatch",
          status: 401,
        }),
      );
    } finally {
      spy.mockRestore();
    }
    expect(logged.join("\n")).toContain("engine submit failed: 401 (signature_mismatch)");
  });
});
