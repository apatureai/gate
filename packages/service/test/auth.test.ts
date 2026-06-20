import { createHmac, generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/app.js";
import { createGitHubAppAuth } from "../src/app-auth.js";
import { createWebhookVerifier } from "../src/webhooks.js";

const SECRET = "webhook-secret";
function sign(body: string, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("createWebhookVerifier", () => {
  const verifier = createWebhookVerifier(SECRET);
  const body = JSON.stringify({ hello: "world" });

  it("accepts a correct signature", async () => {
    expect(await verifier.verify(body, sign(body))).toBe(true);
  });
  it("rejects a wrong signature, wrong secret, and missing signature", async () => {
    expect(await verifier.verify(body, "sha256=deadbeef")).toBe(false);
    expect(await verifier.verify(body, sign(body, "other"))).toBe(false);
    expect(await verifier.verify(body, undefined)).toBe(false);
  });
});

describe("/webhook signature enforcement", () => {
  it("accepts a correctly signed delivery and rejects a bad one", async () => {
    const onPullRequest = vi.fn();
    app = buildServer({ webhookSecret: SECRET, webhook: { onPullRequest } });
    const payload = JSON.stringify({ action: "opened", number: 1 });

    const good = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: { "x-github-event": "pull_request", "content-type": "application/json", "x-hub-signature-256": sign(payload) },
      payload,
    });
    expect(good.statusCode).toBe(202);
    expect(onPullRequest).toHaveBeenCalledOnce();

    const bad = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: { "x-github-event": "pull_request", "content-type": "application/json", "x-hub-signature-256": "sha256=bad" },
      payload,
    });
    expect(bad.statusCode).toBe(401);
    expect(onPullRequest).toHaveBeenCalledOnce(); // not called again
  });

  it("rejects an unsigned delivery when a secret is configured", async () => {
    app = buildServer({ webhookSecret: SECRET });
    const res = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: { "x-github-event": "pull_request", "content-type": "application/json" },
      payload: JSON.stringify({ action: "opened" }),
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("createGitHubAppAuth", () => {
  it("mints an app JWT offline from a private key", async () => {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const auth = createGitHubAppAuth({ appId: 123456, privateKey });
    const jwt = await auth.mintAppJwt();
    expect(jwt.split(".")).toHaveLength(3); // header.payload.signature
    expect(typeof auth.getInstallationToken).toBe("function");
  });
});
