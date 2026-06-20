import { createHmac } from "node:crypto";
import type { CheckRun, GitHubCommentsApi } from "@gate/delivery";
import type { JudgmentEngineClient } from "@gate/engine";
import { loadGoldenReviewResult } from "@gate/types";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProductionAppServer, type InstallationClients } from "../src/production-server.js";
import { createInMemoryFullReviewWindow } from "../src/review-window.js";
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
});
