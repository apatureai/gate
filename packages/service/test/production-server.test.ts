import { createHmac } from "node:crypto";
import { DEFAULT_CONFIG } from "@gate/config";
import type { CheckRun, GitHubCommentsApi } from "@gate/delivery";
import type { JudgmentEngineClient } from "@gate/engine";
import { loadGoldenReviewResult } from "@gate/types";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProductionAppServer, type InstallationClients } from "../src/production-server.js";
import { createInMemoryFullReviewWindow } from "../src/review-window.js";
import { mintFeedbackToken } from "../src/feedback-token.js";
import { createInMemoryScreenshotRegistry, type ScreenshotRecord } from "../src/screenshots.js";
import { createInMemorySupersessionStore } from "../src/supersession.js";
import { createInMemoryReviewWorker } from "../src/worker.js";

const SECRET = "webhook-secret";
const sign = (body: string) => `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
const golden = loadGoldenReviewResult();

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("createProductionAppServer (#62 live App-path composition root)", () => {
  it("a signed deployment_status flows end-to-end: enqueue -> worker -> hydrate -> runHostedReview -> publish", async () => {
    const sha = "abc123";
    const comments: GitHubCommentsApi = {
      listComments: vi.fn(async () => []),
      createComment: vi.fn(async (body) => ({ id: 1, nodeId: "n1", body })),
      updateComment: vi.fn(async () => ({ updated: true })),
    };
    const published: CheckRun[] = [];
    const engine: JudgmentEngineClient = {
      review: vi.fn(async () => ({ status: "completed", result: golden, jobId: "j" })),
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
        const err = new Error("Invalid .designreview.yml");
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
