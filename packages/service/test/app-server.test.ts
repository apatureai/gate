import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createAppServer } from "../src/app-server.js";
import { createInMemorySupersessionStore } from "../src/supersession.js";

const SECRET = "webhook-secret";
const sign = (body: string) => `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("createAppServer (composition root)", () => {
  it("a signed deployment_status webhook flows through to enqueue", async () => {
    const enqueue = vi.fn(async () => "acme/web#42");
    const supersession = createInMemorySupersessionStore();
    app = createAppServer({
      webhookSecret: SECRET,
      supersession,
      worker: { enqueue, cancel: async () => {}, onJob: () => {} },
      resolvePullRequest: async (_o, _n, sha) => ({ number: 42, headSha: sha, baseSha: "b" }),
    });

    const payload = JSON.stringify({
      installation: { id: 1 },
      repository: { name: "web", owner: { login: "acme" } },
      deployment_status: { state: "success", environment_url: "https://acme.vercel.app" },
      deployment: { id: 7, sha: "abc", environment: "Preview" },
    });
    const res = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: { "x-github-event": "deployment_status", "content-type": "application/json", "x-hub-signature-256": sign(payload) },
      payload,
    });

    expect(res.statusCode).toBe(202);
    expect(enqueue).toHaveBeenCalledOnce();
    expect(await supersession.getCurrentSha("sha:acme/web#42")).toBe("abc");
  });

  it("rejects an unsigned webhook before any handler runs", async () => {
    const enqueue = vi.fn(async () => "k");
    app = createAppServer({
      webhookSecret: SECRET,
      supersession: createInMemorySupersessionStore(),
      worker: { enqueue, cancel: async () => {}, onJob: () => {} },
      resolvePullRequest: async () => null,
    });
    const res = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: { "x-github-event": "deployment_status", "content-type": "application/json" },
      payload: JSON.stringify({ deployment_status: { state: "success" } }),
    });
    expect(res.statusCode).toBe(401);
    expect(enqueue).not.toHaveBeenCalled();
  });
});
