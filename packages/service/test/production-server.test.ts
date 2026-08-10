import { createHmac } from "node:crypto";
import { DEFAULT_CONFIG } from "@gate/config";
import type { CheckRun, GitHubCommentsApi } from "@gate/delivery";
import { canonicalReviewIdentity, type JudgmentEngineClient, type ReadinessOptions } from "@gate/engine";
import { loadGoldenReviewResult } from "@gate/types";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProductionAppServer, type InstallationClients } from "../src/production-server.js";
import { createInMemoryFullReviewWindow } from "../src/review-window.js";
import { mintFeedbackToken } from "../src/feedback-token.js";
import { createInMemoryScreenshotRegistry, type ScreenshotRecord } from "../src/screenshots.js";
import { createInMemorySupersessionStore, recordEnqueue } from "../src/supersession.js";
import { createInMemoryReviewWorker } from "../src/worker.js";

const SECRET = "webhook-secret";
const sign = (body: string) => `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
const golden = loadGoldenReviewResult();
const ready = async () => ({ ready: true as const, elapsedMs: 0 });

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("createProductionAppServer (#62 live App-path composition root)", () => {
  it("stops HTTP admission, worker, Redis, and SQL once in that order", async () => {
    const closed: string[] = [];
    const worker = {
      enqueue: vi.fn(async () => "job"),
      cancel: vi.fn(async () => undefined),
      onJob: vi.fn(),
      close: vi.fn(async () => void closed.push("worker")),
    };
    const prod = createProductionAppServer({
      webhookSecret: SECRET,
      supersession: createInMemorySupersessionStore(),
      worker,
      windowStore: createInMemoryFullReviewWindow(),
      resolvePullRequest: async () => null,
      installationClients: () => {
        throw new Error("unused");
      },
      shutdown: {
        closeRedis: vi.fn(async () => void closed.push("redis")),
        closeSql: vi.fn(async () => void closed.push("sql")),
      },
    });
    prod.server.addHook("onClose", async () => void closed.push("http"));
    app = prod.server;
    await prod.start({ host: "127.0.0.1", port: 0 });

    await Promise.all([prod.stop(), prod.stop()]);
    app = undefined;

    expect(closed).toEqual(["http", "worker", "redis", "sql"]);
    expect(worker.close).toHaveBeenCalledOnce();
  });

  it("a signed deployment_status flows end-to-end: enqueue -> worker -> hydrate -> runHostedReview -> publish", async () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const comments: GitHubCommentsApi = {
      listComments: vi.fn(async () => []),
      createComment: vi.fn(async (body) => ({ id: 1, nodeId: "n1", body })),
      updateComment: vi.fn(async () => ({ updated: true })),
    };
    const published: CheckRun[] = [];
    const engine: JudgmentEngineClient = {
      review: vi.fn(async (reviewCtx) => ({
        status: "completed",
        result: golden,
        jobId: "j",
        reviewIdentity: canonicalReviewIdentity(reviewCtx),
      })),
      cancel: vi.fn(async () => {}),
    };
    const installationClients = vi.fn(
      (): InstallationClients => ({
        fetchPullRequest: async () => ({ defaultBranch: "main", title: "Redesign", body: null, isFork: false }),
        comments,
        publishCheckRun: async (r) => void published.push(r),
        engine,
      }),
    );

    const prod = createProductionAppServer({
      webhookSecret: SECRET,
      supersession: createInMemorySupersessionStore(),
      worker: createInMemoryReviewWorker(),
      windowStore: createInMemoryFullReviewWindow(),
      resolvePullRequest: async (_o, _n, s) => ({ number: 42, headSha: s, baseSha: "base" }),
      installationClients,
      previewReadiness: ready,
    });
    app = prod.server;

    const payload = JSON.stringify({
      installation: { id: 1 },
      repository: { name: "web", owner: { login: "acme" } },
      deployment_status: { state: "success", environment_url: "https://acme.vercel.app" },
      deployment: { id: 7, sha, environment: "Preview" },
    });
    const res = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: {
        "x-github-event": "deployment_status",
        "content-type": "application/json",
        "x-hub-signature-256": sign(payload),
      },
      payload,
    });
    expect(res.statusCode).toBe(202);

    // The in-memory worker runs the job asynchronously after enqueue.
    await vi.waitFor(() => expect(published.length).toBeGreaterThan(0));
    expect(installationClients).toHaveBeenCalledOnce();
    expect(engine.review).toHaveBeenCalledOnce();
    expect(comments.createComment).toHaveBeenCalledOnce();
    expect(published[0]?.name).toBe("Apature Gate");
  });

  it("uses the injected per-repo config loader for hosted reviews", async () => {
    const comments: GitHubCommentsApi = {
      listComments: vi.fn(async () => []),
      createComment: vi.fn(async (body) => ({ id: 1, nodeId: "n1", body })),
      updateComment: vi.fn(async () => ({ updated: true })),
    };
    const engine: JudgmentEngineClient = {
      review: vi.fn(async () => ({ status: "completed", result: golden, jobId: "j" })),
      cancel: vi.fn(async () => {}),
    };
    const config = {
      ...DEFAULT_CONFIG,
      rules: { ...DEFAULT_CONFIG.rules, gate: "blockers" as const },
      brand: "Hosted checkout UX",
    };
    const worker = createInMemoryReviewWorker();

    const prod = createProductionAppServer({
      webhookSecret: SECRET,
      supersession: createInMemorySupersessionStore(),
      worker,
      windowStore: createInMemoryFullReviewWindow(),
      resolvePullRequest: async (_o, _n, s) => ({ number: 42, headSha: s, baseSha: "base" }),
      loadConfig: vi.fn(async () => config),
      installationClients: () => ({
        fetchPullRequest: async () => ({ defaultBranch: "main", title: "Redesign", body: null, isFork: false }),
        comments,
        publishCheckRun: vi.fn(async () => {}),
        engine,
      }),
      previewReadiness: ready,
    });
    app = prod.server;

    const payload = JSON.stringify({
      installation: { id: 1 },
      repository: { name: "web", owner: { login: "acme" } },
      deployment_status: { state: "success", environment_url: "https://acme.vercel.app" },
      deployment: { id: 7, sha: "abc123", environment: "Preview" },
    });
    await app.inject({
      method: "POST",
      url: "/webhook",
      headers: {
        "x-github-event": "deployment_status",
        "content-type": "application/json",
        "x-hub-signature-256": sign(payload),
      },
      payload,
    });

    await vi.waitFor(() => expect(engine.review).toHaveBeenCalledOnce());
    expect(engine.review).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ brand: "Hosted checkout UX" }),
        publishMode: "blocking",
      }),
      expect.any(Object),
    );
  });

  it("publishes a neutral Check Run and skips the engine when hosted config is invalid", async () => {
    const published: CheckRun[] = [];
    const comments: GitHubCommentsApi = {
      listComments: vi.fn(async () => []),
      createComment: vi.fn(async (body) => ({ id: 1, nodeId: "n1", body })),
      updateComment: vi.fn(async () => ({ updated: true })),
    };
    const engine: JudgmentEngineClient = {
      review: vi.fn(async () => ({ status: "completed", result: golden, jobId: "j" })),
      cancel: vi.fn(async () => {}),
    };
    const worker = createInMemoryReviewWorker();

    const prod = createProductionAppServer({
      webhookSecret: SECRET,
      supersession: createInMemorySupersessionStore(),
      worker,
      windowStore: createInMemoryFullReviewWindow(),
      resolvePullRequest: async (_o, _n, s) => ({ number: 42, headSha: s, baseSha: "base" }),
      loadConfig: vi.fn(async () => {
        const err = new Error("Invalid .gate.yml");
        err.name = "ConfigValidationError";
        (err as Error & { issues: string[] }).issues = ["rules.gate: Invalid enum value"];
        throw err;
      }),
      installationClients: () => ({
        fetchPullRequest: async () => ({ defaultBranch: "main", title: "Redesign", body: null, isFork: false }),
        comments,
        publishCheckRun: async (run) => void published.push(run),
        engine,
      }),
      previewReadiness: ready,
    });
    app = prod.server;

    const payload = JSON.stringify({
      installation: { id: 1 },
      repository: { name: "web", owner: { login: "acme" } },
      deployment_status: { state: "success", environment_url: "https://acme.vercel.app" },
      deployment: { id: 7, sha: "abc123", environment: "Preview" },
    });
    await app.inject({
      method: "POST",
      url: "/webhook",
      headers: {
        "x-github-event": "deployment_status",
        "content-type": "application/json",
        "x-hub-signature-256": sign(payload),
      },
      payload,
    });

    await vi.waitFor(() => expect(published).toHaveLength(1));
    expect(published[0]).toMatchObject({
      name: "Apature Gate",
      conclusion: "neutral",
      title: "Config invalid",
    });
    expect(published[0]?.summary).toContain("rules.gate");
    expect(engine.review).not.toHaveBeenCalled();
    expect(comments.createComment).not.toHaveBeenCalled();
  });

  it("rejects a cross-origin ready_path before the hosted readiness probe", async () => {
    const published: CheckRun[] = [];
    const previewReadiness = vi.fn(async () => ({ ready: true as const, elapsedMs: 0 }));
    const engine: JudgmentEngineClient = {
      review: vi.fn(async () => ({ status: "completed", result: golden, jobId: "j" })),
      cancel: vi.fn(async () => {}),
    };
    const prod = createProductionAppServer({
      webhookSecret: SECRET,
      supersession: createInMemorySupersessionStore(),
      worker: createInMemoryReviewWorker(),
      windowStore: createInMemoryFullReviewWindow(),
      resolvePullRequest: async (_o, _n, s) => ({ number: 42, headSha: s, baseSha: "base" }),
      loadConfig: async () => ({
        ...DEFAULT_CONFIG,
        preview: {
          ...DEFAULT_CONFIG.preview,
          readyPath: "https://169.254.169.254/latest/meta-data",
        },
      }),
      installationClients: () => ({
        fetchPullRequest: async () => ({ defaultBranch: "main", title: "Redesign", body: null, isFork: false }),
        comments: { listComments: async () => [], createComment: vi.fn(), updateComment: vi.fn() } as unknown as GitHubCommentsApi,
        publishCheckRun: async (run) => void published.push(run),
        engine,
      }),
      previewReadiness,
    });
    app = prod.server;

    const payload = JSON.stringify({
      installation: { id: 1 },
      repository: { name: "web", owner: { login: "acme" } },
      deployment_status: { state: "success", environment_url: "https://acme.vercel.app" },
      deployment: { id: 7, sha: "abc123", environment: "Preview" },
    });
    await app.inject({
      method: "POST",
      url: "/webhook",
      headers: {
        "x-github-event": "deployment_status",
        "content-type": "application/json",
        "x-hub-signature-256": sign(payload),
      },
      payload,
    });

    await vi.waitFor(() => expect(published).toHaveLength(1));
    expect(published[0]).toMatchObject({
      conclusion: "neutral",
      title: "Config invalid",
    });
    expect(published[0]?.summary).toContain("preview.ready_path");
    expect(previewReadiness).not.toHaveBeenCalled();
    expect(engine.review).not.toHaveBeenCalled();
  });

  it("publishes a neutral Check Run and does not call the engine when preview readiness times out", async () => {
    const engine: JudgmentEngineClient = {
      review: vi.fn(async () => ({ status: "completed", result: golden, jobId: "j" })),
      cancel: vi.fn(async () => {}),
    };
    const comments: GitHubCommentsApi = {
      listComments: vi.fn(async () => []),
      createComment: vi.fn(async (body) => ({ id: 1, nodeId: "n1", body })),
      updateComment: vi.fn(async () => ({ updated: true })),
    };
    const published: CheckRun[] = [];
    const prod = createProductionAppServer({
      webhookSecret: SECRET,
      supersession: createInMemorySupersessionStore(),
      worker: createInMemoryReviewWorker(),
      windowStore: createInMemoryFullReviewWindow(),
      resolvePullRequest: async (_o, _n, s) => ({ number: 42, headSha: s, baseSha: "base" }),
      loadConfig: async () => ({
        ...DEFAULT_CONFIG,
        preview: {
          ...DEFAULT_CONFIG.preview,
          readyPath: "/healthz",
          readyStatus: [204],
        },
      }),
      installationClients: () => ({
        fetchPullRequest: async () => ({ defaultBranch: "main", title: "Redesign", body: null, isFork: false }),
        comments,
        publishCheckRun: async (r) => void published.push(r),
        engine,
      }),
      previewReadiness: async () => ({ ready: false, reason: "ceiling_exceeded" }),
    });
    app = prod.server;

    const payload = JSON.stringify({
      installation: { id: 1 },
      repository: { name: "web", owner: { login: "acme" } },
      deployment_status: { state: "success", environment_url: "https://acme.vercel.app" },
      deployment: { id: 7, sha: "abc123", environment: "Preview" },
    });
    const res = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: {
        "x-github-event": "deployment_status",
        "content-type": "application/json",
        "x-hub-signature-256": sign(payload),
      },
      payload,
    });
    expect(res.statusCode).toBe(202);

    await vi.waitFor(() => expect(published).toHaveLength(1));
    expect(published[0]).toMatchObject({
      name: "Apature Gate",
      conclusion: "neutral",
      title: "Preview not ready",
    });
    expect(published[0]?.summary).toBe(
      "Preview did not respond with an accepted HTTP status (204) at https://acme.vercel.app/healthz within 120s. Not reviewed.",
    );
    expect(engine.review).not.toHaveBeenCalled();
    expect(comments.createComment).not.toHaveBeenCalled();
  });

  it("passes wait_seconds and the worker AbortSignal into the readiness poll", async () => {
    const seen: ReadinessOptions[] = [];
    const prod = createProductionAppServer({
      webhookSecret: SECRET,
      supersession: createInMemorySupersessionStore(),
      worker: createInMemoryReviewWorker(),
      windowStore: createInMemoryFullReviewWindow(),
      resolvePullRequest: async (_o, _n, s) => ({ number: 42, headSha: s, baseSha: "base" }),
      installationClients: () => ({
        fetchPullRequest: async () => ({ defaultBranch: "main", title: "Redesign", body: null, isFork: false }),
        comments: { listComments: async () => [], createComment: vi.fn(), updateComment: vi.fn() } as unknown as GitHubCommentsApi,
        publishCheckRun: vi.fn(),
        engine: { review: vi.fn(async () => ({ status: "failed", error: "unused", jobId: "j" })), cancel: vi.fn() },
      }),
      loadConfig: async () => ({
        ...DEFAULT_CONFIG,
        preview: { ...DEFAULT_CONFIG.preview, waitSeconds: 7 },
      }),
      previewReadiness: async (options) => {
        seen.push(options);
        return { ready: false, reason: "aborted" };
      },
    });
    app = prod.server;

    const payload = JSON.stringify({
      installation: { id: 1 },
      repository: { name: "web", owner: { login: "acme" } },
      deployment_status: { state: "success", environment_url: "https://acme.vercel.app" },
      deployment: { id: 7, sha: "abc123", environment: "Preview" },
    });
    await app.inject({
      method: "POST",
      url: "/webhook",
      headers: {
        "x-github-event": "deployment_status",
        "content-type": "application/json",
        "x-hub-signature-256": sign(payload),
      },
      payload,
    });

    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]?.url).toBe("https://acme.vercel.app/");
    expect(seen[0]?.waitSeconds).toBe(7);
    expect(seen[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(seen[0]?.acceptStatus).toBeUndefined();
  });

  it("probes the configured ready_path instead of the deployment root", async () => {
    const engine: JudgmentEngineClient = {
      review: vi.fn(async () => ({ status: "completed", result: golden, jobId: "j" })),
      cancel: vi.fn(async () => {}),
    };
    const seenUrls: string[] = [];
    const prod = createProductionAppServer({
      webhookSecret: SECRET,
      supersession: createInMemorySupersessionStore(),
      worker: createInMemoryReviewWorker(),
      windowStore: createInMemoryFullReviewWindow(),
      resolvePullRequest: async (_o, _n, s) => ({ number: 42, headSha: s, baseSha: "base" }),
      loadConfig: async () => ({
        ...DEFAULT_CONFIG,
        preview: { ...DEFAULT_CONFIG.preview, readyPath: "/healthz" },
      }),
      installationClients: () => ({
        fetchPullRequest: async () => ({ defaultBranch: "main", title: "Redesign", body: null, isFork: false }),
        comments: { listComments: async () => [], createComment: vi.fn(), updateComment: vi.fn() } as unknown as GitHubCommentsApi,
        publishCheckRun: vi.fn(),
        engine,
      }),
      previewReadiness: async (options) => {
        seenUrls.push(options.url);
        return options.url.endsWith("/healthz")
          ? { ready: true, elapsedMs: 0 }
          : { ready: false, reason: "ceiling_exceeded" };
      },
    });
    app = prod.server;

    const payload = JSON.stringify({
      installation: { id: 1 },
      repository: { name: "web", owner: { login: "acme" } },
      deployment_status: { state: "success", environment_url: "https://acme.vercel.app" },
      deployment: { id: 7, sha: "abc123", environment: "Preview" },
    });
    await app.inject({
      method: "POST",
      url: "/webhook",
      headers: {
        "x-github-event": "deployment_status",
        "content-type": "application/json",
        "x-hub-signature-256": sign(payload),
      },
      payload,
    });

    await vi.waitFor(() => expect(engine.review).toHaveBeenCalledOnce());
    expect(seenUrls).toEqual(["https://acme.vercel.app/healthz"]);
  });

  it("uses the configured ready_status set instead of the hosted strict-200 default", async () => {
    const engine: JudgmentEngineClient = {
      review: vi.fn(async () => ({ status: "completed", result: golden, jobId: "j" })),
      cancel: vi.fn(async () => {}),
    };
    const acceptedStatuses: Array<[number, boolean]> = [];
    const prod = createProductionAppServer({
      webhookSecret: SECRET,
      supersession: createInMemorySupersessionStore(),
      worker: createInMemoryReviewWorker(),
      windowStore: createInMemoryFullReviewWindow(),
      resolvePullRequest: async (_o, _n, s) => ({ number: 42, headSha: s, baseSha: "base" }),
      loadConfig: async () => ({
        ...DEFAULT_CONFIG,
        preview: { ...DEFAULT_CONFIG.preview, readyStatus: [204, 503] },
      }),
      installationClients: () => ({
        fetchPullRequest: async () => ({ defaultBranch: "main", title: "Redesign", body: null, isFork: false }),
        comments: { listComments: async () => [], createComment: vi.fn(), updateComment: vi.fn() } as unknown as GitHubCommentsApi,
        publishCheckRun: vi.fn(),
        engine,
      }),
      previewReadiness: async (options) => {
        const acceptStatus = options.acceptStatus;
        if (!acceptStatus) return { ready: false, reason: "ceiling_exceeded" };
        acceptedStatuses.push([200, acceptStatus(200)], [204, acceptStatus(204)], [503, acceptStatus(503)]);
        return acceptStatus(503)
          ? { ready: true, elapsedMs: 0 }
          : { ready: false, reason: "ceiling_exceeded" };
      },
    });
    app = prod.server;

    const payload = JSON.stringify({
      installation: { id: 1 },
      repository: { name: "web", owner: { login: "acme" } },
      deployment_status: { state: "success", environment_url: "https://acme.vercel.app" },
      deployment: { id: 7, sha: "abc123", environment: "Preview" },
    });
    await app.inject({
      method: "POST",
      url: "/webhook",
      headers: {
        "x-github-event": "deployment_status",
        "content-type": "application/json",
        "x-hub-signature-256": sign(payload),
      },
      payload,
    });

    await vi.waitFor(() => expect(engine.review).toHaveBeenCalledOnce());
    expect(acceptedStatuses).toEqual([
      [200, false],
      [204, true],
      [503, true],
    ]);
  });

  it("does not publish a not-ready Check Run after a newer push supersedes the job", async () => {
    const supersession = createInMemorySupersessionStore();
    const published: CheckRun[] = [];
    let resolveReadiness: ((value: { ready: false; reason: "ceiling_exceeded" }) => void) | undefined;
    const readinessStarted = vi.fn();
    const prod = createProductionAppServer({
      webhookSecret: SECRET,
      supersession,
      worker: createInMemoryReviewWorker(),
      windowStore: createInMemoryFullReviewWindow(),
      resolvePullRequest: async (_o, _n, s) => ({ number: 42, headSha: s, baseSha: "base" }),
      installationClients: () => ({
        fetchPullRequest: async () => ({ defaultBranch: "main", title: "Redesign", body: null, isFork: false }),
        comments: { listComments: async () => [], createComment: vi.fn(), updateComment: vi.fn() } as unknown as GitHubCommentsApi,
        publishCheckRun: async (r) => void published.push(r),
        engine: { review: vi.fn(async () => ({ status: "failed", error: "unused", jobId: "j" })), cancel: vi.fn() },
      }),
      previewReadiness: async () => {
        readinessStarted();
        return new Promise((resolve) => {
          resolveReadiness = resolve;
        });
      },
    });
    app = prod.server;

    const payload = JSON.stringify({
      installation: { id: 1 },
      repository: { name: "web", owner: { login: "acme" } },
      deployment_status: { state: "success", environment_url: "https://acme.vercel.app" },
      deployment: { id: 7, sha: "abc123", environment: "Preview" },
    });
    await app.inject({
      method: "POST",
      url: "/webhook",
      headers: {
        "x-github-event": "deployment_status",
        "content-type": "application/json",
        "x-hub-signature-256": sign(payload),
      },
      payload,
    });
    await vi.waitFor(() => expect(readinessStarted).toHaveBeenCalledOnce());
    await recordEnqueue(supersession, { owner: "acme", name: "web", prNumber: 42 }, "newer");
    resolveReadiness?.({ ready: false, reason: "ceiling_exceeded" });

    await new Promise((r) => setTimeout(r, 0));
    expect(await supersession.getCurrentSha("sha:acme/web#42")).toBe("newer");
    expect(published).toHaveLength(0);
  });

  it("runs startup checks before listening and fails fast when an invariant is violated", async () => {
    const prod = createProductionAppServer({
      webhookSecret: SECRET,
      supersession: createInMemorySupersessionStore(),
      worker: createInMemoryReviewWorker(),
      windowStore: createInMemoryFullReviewWindow(),
      resolvePullRequest: async () => null,
      installationClients: () => {
        throw new Error("unused");
      },
      startup: {
        // CONFIG GET returns [key, value]; allkeys-lru violates the noeviction invariant.
        redis: { config: async () => ["maxmemory-policy", "allkeys-lru"] },
      },
    });
    app = prod.server;
    // allkeys-lru violates the noeviction invariant -> start() rejects, never listens.
    await expect(prod.start({ port: 0 })).rejects.toThrow();
  });

  it("mounts screenshot and feedback routes when route deps are injected", async () => {
    const screenshotRegistry = createInMemoryScreenshotRegistry();
    const screenshot: ScreenshotRecord = {
      artifactId: "art_1",
      findingId: "f_001",
      headSha: "abc",
      objectKey: "jobs/1/shot.png",
      expiresAt: 10_000,
      installationId: "1",
      owner: "acme",
      name: "web",
      visibility: "private",
    };
    await screenshotRegistry.record([screenshot]);
    const feedbackSecret = "feedback-secret";
    const recordedFeedback: unknown[] = [];

    const prod = createProductionAppServer({
      webhookSecret: SECRET,
      supersession: createInMemorySupersessionStore(),
      worker: createInMemoryReviewWorker(),
      windowStore: createInMemoryFullReviewWindow(),
      resolvePullRequest: async () => null,
      installationClients: () => {
        throw new Error("unused");
      },
      screenshotRegistry,
      screenshotRoute: {
        signer: { sign: async (key) => `https://signed.example.com/${key}` },
        capabilitySecret: "cap-secret",
        now: () => 5_000,
        authorizer: {
          authorize: (request, record) => request.headers["x-installation"] === record.installationId,
        },
      },
      feedbackRoutes: {
        secret: feedbackSecret,
        sink: { record: async (event) => void recordedFeedback.push(event) },
        now: () => 1_000,
      },
    });
    app = prod.server;

    const shot = await app.inject({
      method: "GET",
      url: "/i/art_1.png",
      headers: { "x-installation": "1" },
    });
    expect(shot.statusCode).toBe(302);
    expect(shot.headers.location).toBe("https://signed.example.com/jobs/1/shot.png");

    const inertGet = await app.inject({ method: "GET", url: "/feedback" });
    expect(inertGet.statusCode).toBe(405);
    const token = mintFeedbackToken(
      {
        type: "reaction",
        installationId: "1",
        owner: "acme",
        name: "web",
        prNumber: 42,
        headSha: "abc",
        findingId: "f_001",
        exp: 2_000,
      },
      feedbackSecret,
    );
    const post = await app.inject({ method: "POST", url: "/feedback", payload: { token } });
    expect(post.statusCode).toBe(200);
    expect(recordedFeedback).toHaveLength(1);
  });
});
