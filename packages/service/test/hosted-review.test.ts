import type { CheckRun, GitHubCommentsApi } from "@gate/delivery";
import { EngineAbortedError, type JudgmentEngineClient } from "@gate/engine";
import { DEFAULT_CONFIG } from "@gate/config";
import { loadGoldenReviewResult } from "@gate/types";
import { describe, expect, it, vi } from "vitest";
import { createInMemoryFeedbackStore, createFeedbackSink } from "../src/feedback-store.js";
import {
  createAppWebhookHandlers,
  createDeploymentStatusHandler,
  type HostedReviewContext,
  runHostedReview,
} from "../src/hosted-review.js";
import { createInMemoryReviewWorker } from "../src/worker.js";
import { createInMemoryFullReviewWindow } from "../src/review-window.js";
import { createInMemoryRunStore } from "../src/run-store.js";
import { createInMemorySupersessionStore, recordEnqueue } from "../src/supersession.js";

const golden = loadGoldenReviewResult();

const ctx: HostedReviewContext = {
  installationId: "1",
  repository: { owner: "acme", name: "web", defaultBranch: "main" },
  pullRequest: { number: 42, headSha: "abc", baseSha: "def", title: "Redesign", body: null },
  isFork: false,
  preview: { url: "https://acme.vercel.app", provider: "vercel", source: "deployment_status" },
};

function engine(outcome: Awaited<ReturnType<JudgmentEngineClient["review"]>> | Error): JudgmentEngineClient {
  return {
    review: vi.fn(async () => {
      if (outcome instanceof Error) throw outcome;
      return outcome;
    }),
    cancel: vi.fn(async () => {}),
  };
}

function deps(engineClient: JudgmentEngineClient) {
  const comments: GitHubCommentsApi = {
    listComments: vi.fn(async () => []),
    createComment: vi.fn(async (body) => ({ id: 1, nodeId: "n1", body })),
    updateComment: vi.fn(async () => ({ updated: true })),
  };
  const published: CheckRun[] = [];
  const supersession = createInMemorySupersessionStore();
  const feedbackStore = createInMemoryFeedbackStore();
  return {
    supersession,
    windowStore: createInMemoryFullReviewWindow(),
    engine: engineClient,
    comments,
    publishCheckRun: vi.fn(async (r: CheckRun) => void published.push(r)),
    feedback: createFeedbackSink(feedbackStore),
    runUrl: "https://gate.app/runs/1",
    _published: published,
    _feedback: feedbackStore,
  };
}

describe("runHostedReview", () => {
  it("publishes a completed review, records full review + feedback", async () => {
    const d = deps(engine({ status: "completed", result: golden, jobId: "j" }));
    await recordEnqueue(d.supersession, { owner: "acme", name: "web", prNumber: 42 }, "abc");

    const out = await runHostedReview(DEFAULT_CONFIG, ctx, d);
    expect(out.status).toBe("published");
    expect(d.comments.createComment).toHaveBeenCalledOnce();
    expect(d._published).toHaveLength(1);
    expect(d._feedback.events).toHaveLength(1);
    expect(await d.windowStore.getLastFullReviewAt({ owner: "acme", name: "web", prNumber: 42 })).not.toBeNull();
  });

  it("discards a stale result via the publish-time guard (newer push)", async () => {
    const d = deps(engine({ status: "completed", result: golden, jobId: "j" }));
    await recordEnqueue(d.supersession, { owner: "acme", name: "web", prNumber: 42 }, "abc");
    // a newer push lands current_sha = "newer" before publish
    await recordEnqueue(d.supersession, { owner: "acme", name: "web", prNumber: 42 }, "newer");

    const out = await runHostedReview(DEFAULT_CONFIG, ctx, d);
    expect(out.status).toBe("stale_discarded");
    expect(d.comments.createComment).not.toHaveBeenCalled();
    expect(d._published).toHaveLength(0);
  });

  it("returns superseded and best-effort cancels the engine job when aborted", async () => {
    const d = deps(engine(new EngineAbortedError("job_super")));
    await recordEnqueue(d.supersession, { owner: "acme", name: "web", prNumber: 42 }, "abc");
    const out = await runHostedReview(DEFAULT_CONFIG, ctx, d);
    expect(out.status).toBe("superseded");
    expect(d._published).toHaveLength(0);
    expect(d.engine.cancel).toHaveBeenCalledWith("job_super"); // DELETE /jobs/:id on supersession
  });

  it("posts a neutral Check Run (never crashes the worker) when the engine throws", async () => {
    const d = deps(engine(new Error("engine 503")));
    await recordEnqueue(d.supersession, { owner: "acme", name: "web", prNumber: 42 }, "abc");
    const out = await runHostedReview(DEFAULT_CONFIG, ctx, d);
    expect(out.status).toBe("engine_error");
    expect(d._published[0]?.conclusion).toBe("neutral");
    expect(d.comments.createComment).not.toHaveBeenCalled();
  });

  it("does not publish an engine-error Check Run after a newer push", async () => {
    const d = deps(engine(new Error("engine 503")));
    await recordEnqueue(d.supersession, { owner: "acme", name: "web", prNumber: 42 }, "newer");
    const out = await runHostedReview(DEFAULT_CONFIG, ctx, d);
    expect(out.status).toBe("stale_discarded");
    expect(d._published).toHaveLength(0);
  });

  it("posts a neutral Check Run when the preview is unverified", async () => {
    const d = deps(engine({ status: "completed", result: golden, jobId: "j" }));
    await recordEnqueue(d.supersession, { owner: "acme", name: "web", prNumber: 42 }, "abc");
    const out = await runHostedReview(DEFAULT_CONFIG, { ...ctx, preview: { url: "https://evil.example.com", provider: "vercel", source: "deployment_status" } }, d);
    expect(out.status).toBe("unverified_preview");
    expect(d._published[0]?.conclusion).toBe("neutral");
    expect(d.engine.review).not.toHaveBeenCalled();
  });

  it("does not publish an unverified-preview Check Run after a newer push", async () => {
    const d = deps(engine({ status: "completed", result: golden, jobId: "j" }));
    await recordEnqueue(d.supersession, { owner: "acme", name: "web", prNumber: 42 }, "newer");
    const out = await runHostedReview(
      DEFAULT_CONFIG,
      { ...ctx, preview: { url: "https://evil.example.com", provider: "vercel", source: "deployment_status" } },
      d,
    );
    expect(out.status).toBe("stale_discarded");
    expect(d._published).toHaveLength(0);
  });

  it("removes auth and bypass secret names before handing a fork PR to the engine", async () => {
    const engineClient = engine({ status: "completed", result: golden, jobId: "j" });
    const d = deps(engineClient);
    const config = {
      ...DEFAULT_CONFIG,
      preview: {
        ...DEFAULT_CONFIG.preview,
        protectionBypassSecretName: "BYPASS_SECRET",
        authStateSecretName: "AUTH_STATE_SECRET",
      },
    };
    await recordEnqueue(d.supersession, { owner: "acme", name: "web", prNumber: 42 }, "abc");

    await runHostedReview(config, { ...ctx, isFork: true }, d);

    const request = (engineClient.review as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(request.config.preview.protectionBypassSecretName).toBeNull();
    expect(request.config.preview.authStateSecretName).toBeNull();
    expect(config.preview.protectionBypassSecretName).toBe("BYPASS_SECRET");
  });
});

describe("createDeploymentStatusHandler", () => {
  it("resolves the preview, records current_sha, and enqueues the review", async () => {
    const supersession = createInMemorySupersessionStore();
    const worker = createInMemoryReviewWorker();
    const enqueued: string[] = [];
    worker.onJob(async (job) => void enqueued.push(`${job.owner}/${job.name}#${job.prNumber}@${job.headSha}`));

    const handler = createDeploymentStatusHandler({
      supersession,
      worker,
      resolvePullRequest: async (_o, _n, sha) => ({ number: 42, headSha: sha, baseSha: "def" }),
    });
    await handler({
      installation: { id: 1 },
      repository: { name: "web", owner: { login: "acme" } },
      deployment_status: { state: "success", environment_url: "https://acme.vercel.app" },
      deployment: { id: 7, sha: "abc", environment: "Preview" },
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(await supersession.getCurrentSha("sha:acme/web#42")).toBe("abc");
    expect(enqueued).toEqual(["acme/web#42@abc"]);
  });

  it("enqueues non-Vercel deployments with the verified provider", async () => {
    const enqueue = vi.fn(async () => "k");
    const handler = createDeploymentStatusHandler({
      supersession: createInMemorySupersessionStore(),
      worker: { enqueue, cancel: async () => {}, onJob: () => {} },
      resolvePullRequest: async (_o, _n, sha) => ({ number: 42, headSha: sha, baseSha: "def" }),
    });

    await handler({
      installation: { id: 1 },
      repository: { name: "web", owner: { login: "acme" } },
      deployment_status: {
        state: "success",
        environment_url: "https://deploy-preview-42--acme.netlify.app",
      },
      deployment: { id: 7, sha: "abc", environment: "Preview" },
    });

    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ previewProvider: "netlify" }));
  });

  it("ignores non-success / non-matching deployments", async () => {
    const enqueue = vi.fn(async () => "k");
    const handler = createDeploymentStatusHandler({
      supersession: createInMemorySupersessionStore(),
      worker: { enqueue, cancel: async () => {}, onJob: () => {} },
      resolvePullRequest: async () => null,
    });
    await handler({
      installation: { id: 1 },
      repository: { name: "web", owner: { login: "acme" } },
      deployment_status: { state: "failure" },
      deployment: { id: 1, sha: "x", environment: "Preview" },
    });
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("createAppWebhookHandlers", () => {
  it("a pull_request push bumps current_sha and cancels the in-flight review", async () => {
    const supersession = createInMemorySupersessionStore();
    const cancelled: string[] = [];
    const worker = {
      enqueue: vi.fn(async () => "k"),
      cancel: vi.fn(async (key: string) => void cancelled.push(key)),
      onJob: () => {},
    };
    const handlers = createAppWebhookHandlers({
      supersession,
      worker,
      resolvePullRequest: async (_o, _n, sha) => ({ number: 42, headSha: sha, baseSha: "b" }),
    });

    await handlers.onPullRequest({
      repository: { name: "web", owner: { login: "acme" } },
      pull_request: { number: 42, head: { sha: "newsha" } },
    });

    expect(await supersession.getCurrentSha("sha:acme/web#42")).toBe("newsha");
    expect(cancelled).toEqual(["acme/web#42"]); // newest push cancels the older in-flight review
  });

  it("ignores a malformed pull_request payload", async () => {
    const worker = { enqueue: vi.fn(async () => "k"), cancel: vi.fn(async () => {}), onJob: () => {} };
    const handlers = createAppWebhookHandlers({
      supersession: createInMemorySupersessionStore(),
      worker,
      resolvePullRequest: async () => null,
    });
    await handlers.onPullRequest({ repository: { name: "web" } }); // missing owner/pr/sha
    expect(worker.cancel).not.toHaveBeenCalled();
  });
});

describe("runHostedReview durable run persistence (#69)", () => {
  it("persists a completed published review to the run store", async () => {
    const runStore = createInMemoryRunStore();
    const d = { ...deps(engine({ status: "completed", result: golden, jobId: "j" })), runStore };
    await recordEnqueue(d.supersession, { owner: "acme", name: "web", prNumber: 42 }, "abc");

    const out = await runHostedReview(DEFAULT_CONFIG, ctx, d);
    expect(out.status).toBe("published");
    expect(runStore.runs.size).toBe(1);
    const [stored] = [...runStore.runs.values()];
    expect(stored).toMatchObject({ owner: "acme", name: "web", prNumber: 42, headSha: "abc", grade: golden.grade });
    expect(stored?.lastFullReviewAtMs).toBeTypeOf("number"); // deep -> window recorded
  });

  it("does NOT persist a run for superseded / stale / engine-error / unverified reviews", async () => {
    // stale (newer push before publish)
    const stale = { ...deps(engine({ status: "completed", result: golden, jobId: "j" })), runStore: createInMemoryRunStore() };
    await recordEnqueue(stale.supersession, { owner: "acme", name: "web", prNumber: 42 }, "newer");
    expect((await runHostedReview(DEFAULT_CONFIG, ctx, stale)).status).toBe("stale_discarded");
    expect(stale.runStore.runs.size).toBe(0);

    // superseded (engine aborted)
    const sup = { ...deps(engine(new EngineAbortedError("j"))), runStore: createInMemoryRunStore() };
    await recordEnqueue(sup.supersession, { owner: "acme", name: "web", prNumber: 42 }, "abc");
    expect((await runHostedReview(DEFAULT_CONFIG, ctx, sup)).status).toBe("superseded");
    expect(sup.runStore.runs.size).toBe(0);

    // engine error
    const err = { ...deps(engine(new Error("503"))), runStore: createInMemoryRunStore() };
    await recordEnqueue(err.supersession, { owner: "acme", name: "web", prNumber: 42 }, "abc");
    expect((await runHostedReview(DEFAULT_CONFIG, ctx, err)).status).toBe("engine_error");
    expect(err.runStore.runs.size).toBe(0);

    // unverified preview
    const unv = { ...deps(engine({ status: "completed", result: golden, jobId: "j" })), runStore: createInMemoryRunStore() };
    await recordEnqueue(unv.supersession, { owner: "acme", name: "web", prNumber: 42 }, "abc");
    const out = await runHostedReview(
      DEFAULT_CONFIG,
      { ...ctx, preview: { url: "https://evil.example.com", provider: "vercel", source: "deployment_status" } },
      unv,
    );
    expect(out.status).toBe("unverified_preview");
    expect(unv.runStore.runs.size).toBe(0);
  });
});
