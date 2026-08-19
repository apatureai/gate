import { getTracer, type Span, SPAN_NAMES } from "@gate/observability";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import type { WebhookDedupeStore } from "./webhook-dedup.js";
import { createWebhookVerifier } from "./webhooks.js";

/** Handlers the webhook receiver dispatches to (wired by #3 enqueue, etc.). */
export interface WebhookHandlers {
  onPullRequest?(payload: unknown, delivery: string | undefined): Promise<void> | void;
  onDeploymentStatus?(payload: unknown, delivery: string | undefined): Promise<void> | void;
  /**
   * A push. Only a push to the repository's DEFAULT branch does anything, and
   * what it does is record a measurement baseline for the new commit: no model
   * call, no critique, no Check Run and no comment. Nothing about a push is a
   * review, and nothing it produces may render as one.
   */
  onPush?(payload: unknown, delivery: string | undefined): Promise<void> | void;
}

export interface BuildServerOptions {
  /** Enable Fastify's pino logger (off in tests). */
  logger?: boolean;
  /** Webhook event handlers; default no-ops. */
  webhook?: WebhookHandlers;
  /** GitHub webhook secret; when set, requests are HMAC-verified (#2). */
  webhookSecret?: string;
  /** Delivery dedup store; when set, duplicate X-GitHub-Delivery ids skip (#49). */
  webhookDedupe?: WebhookDedupeStore;
  /** Readiness probe; defaults to always-ready. */
  readiness?: () => boolean | Promise<boolean>;
}

const requestSpans = new WeakMap<FastifyRequest, Span>();
const rawBodies = new WeakMap<FastifyRequest, string>();

/**
 * Build the Gate App-path HTTP server (TRD §2): webhook receiver for
 * `pull_request`, `deployment_status` and `push`, health + readiness routes, and an OTel
 * span per request. The factory is pure (no listen) so it injects in tests.
 * GitHub HMAC webhook verification is added in #2.
 */
export function buildServer(options: BuildServerOptions = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });
  const handlers = options.webhook ?? {};
  const verifier = options.webhookSecret ? createWebhookVerifier(options.webhookSecret) : undefined;

  // Capture the raw JSON body so the HMAC can be verified over exact bytes.
  if (verifier) {
    app.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
      const raw = typeof body === "string" ? body : body.toString("utf8");
      rawBodies.set(request, raw);
      try {
        done(null, raw === "" ? {} : JSON.parse(raw));
      } catch (err) {
        done(err as Error);
      }
    });
  }

  // One OTel span per request (TRD §13).
  app.addHook("onRequest", async (request) => {
    const name = request.url.startsWith("/webhook") ? SPAN_NAMES.webhookReceive : `http ${request.method}`;
    requestSpans.set(request, getTracer().startSpan(name));
  });
  app.addHook("onResponse", async (request, reply) => {
    const span = requestSpans.get(request);
    if (span) {
      span.setAttribute("http.method", request.method);
      span.setAttribute("http.route", request.url);
      span.setAttribute("http.status_code", reply.statusCode);
      span.end();
      requestSpans.delete(request);
    }
  });

  // Liveness probe for Fly health checks (TRD §2).
  app.get("/healthz", async () => ({ status: "ok" }));

  // Readiness probe (deps reachable).
  app.get("/readyz", async (_request, reply) => {
    const ready = options.readiness ? await options.readiness() : true;
    return reply.code(ready ? 200 : 503).send({ ready });
  });

  // GitHub webhook receiver. HMAC verification is added in #2.
  app.post("/webhook", async (request, reply) => {
    const event = request.headers["x-github-event"];
    const delivery = asHeader(request.headers["x-github-delivery"]);

    // Reject forged/unsigned deliveries before any work (#2).
    if (verifier) {
      const signature = asHeader(request.headers["x-hub-signature-256"]);
      const ok = await verifier.verify(rawBodies.get(request) ?? "", signature);
      if (!ok) return reply.code(401).send({ error: "invalid_signature" });
    }

    // At-least-once delivery dedup (#49): reserve before dispatch so concurrent
    // duplicates skip, but release the reservation if dispatch fails so GitHub's
    // retry can recover (#97).
    let reservedDelivery = false;
    if (options.webhookDedupe && delivery) {
      if (await options.webhookDedupe.seenDelivery(delivery)) {
        return reply.code(200).send({ duplicate: true });
      }
      reservedDelivery = true;
    }

    try {
      if (event === "pull_request") {
        await handlers.onPullRequest?.(request.body, delivery);
        return reply.code(202).send({ accepted: true, event });
      }
      if (event === "deployment_status") {
        await handlers.onDeploymentStatus?.(request.body, delivery);
        return reply.code(202).send({ accepted: true, event });
      }
      if (event === "push") {
        await handlers.onPush?.(request.body, delivery);
        return reply.code(202).send({ accepted: true, event });
      }
    } catch (err) {
      if (reservedDelivery && delivery) {
        await options.webhookDedupe?.releaseDelivery(delivery).catch(() => undefined);
      }
      throw err;
    }
    // Accept-and-ignore other events so GitHub sees a 2xx and stops retrying.
    return reply.code(202).send({ ignored: true, event });
  });

  return app;
}

function asHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
