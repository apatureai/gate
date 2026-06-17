import { getTracer, type Span, SPAN_NAMES } from "@gate/observability";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";

/** Handlers the webhook receiver dispatches to (wired by #3 enqueue, etc.). */
export interface WebhookHandlers {
  onPullRequest?(payload: unknown, delivery: string | undefined): Promise<void> | void;
  onDeploymentStatus?(payload: unknown, delivery: string | undefined): Promise<void> | void;
}

export interface BuildServerOptions {
  /** Enable Fastify's pino logger (off in tests). */
  logger?: boolean;
  /** Webhook event handlers; default no-ops. */
  webhook?: WebhookHandlers;
  /** Readiness probe; defaults to always-ready. */
  readiness?: () => boolean | Promise<boolean>;
}

const requestSpans = new WeakMap<FastifyRequest, Span>();

/**
 * Build the Gate App-path HTTP server (TRD §2): webhook receiver for
 * `pull_request` and `deployment_status`, health + readiness routes, and an OTel
 * span per request. The factory is pure (no listen) so it injects in tests.
 * GitHub HMAC webhook verification is added in #2.
 */
export function buildServer(options: BuildServerOptions = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });
  const handlers = options.webhook ?? {};

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

    if (event === "pull_request") {
      await handlers.onPullRequest?.(request.body, delivery);
      return reply.code(202).send({ accepted: true, event });
    }
    if (event === "deployment_status") {
      await handlers.onDeploymentStatus?.(request.body, delivery);
      return reply.code(202).send({ accepted: true, event });
    }
    // Accept-and-ignore other events so GitHub sees a 2xx and stops retrying.
    return reply.code(202).send({ ignored: true, event });
  });

  return app;
}

function asHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
