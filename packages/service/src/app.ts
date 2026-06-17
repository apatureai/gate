import Fastify, { type FastifyInstance } from "fastify";

export interface BuildServerOptions {
  /** Enable Fastify's pino logger (off in tests). */
  logger?: boolean;
}

/**
 * Build the Gate App-path HTTP server. This scaffold exposes the deploy
 * health check; the webhook receiver and routes are added in #1/#2. Keeping the
 * factory pure (no listen) makes it injectable in tests.
 */
export function buildServer(options: BuildServerOptions = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });

  // Readiness/liveness probe for Fly health checks (TRD §2).
  app.get("/healthz", async () => ({ status: "ok" }));

  return app;
}
