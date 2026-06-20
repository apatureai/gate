import type { FastifyInstance } from "fastify";
import { buildServer } from "./app.js";
import { createAppWebhookHandlers, type DeploymentHandlerDeps } from "./hosted-review.js";
import type { WebhookDedupeStore } from "./webhook-dedup.js";

/**
 * App-path composition root: assembles the Fastify server (#1) + HMAC webhook
 * verification (#2) + delivery dedup (#49) with the App webhook handlers (#55/#23
 * → supersession/enqueue). Pass the infra-backed deps (worker, supersession
 * store, PR fetcher, secret, dedup store); the worker's onJob runs
 * runHostedReview. Returns a ready-to-listen Fastify instance.
 */
export interface AppServerDeps extends DeploymentHandlerDeps {
  webhookSecret?: string;
  webhookDedupe?: WebhookDedupeStore;
  readiness?: () => boolean | Promise<boolean>;
  logger?: boolean;
}

export function createAppServer(deps: AppServerDeps): FastifyInstance {
  const handlers = createAppWebhookHandlers(deps);
  return buildServer({
    logger: deps.logger,
    webhookSecret: deps.webhookSecret,
    webhookDedupe: deps.webhookDedupe,
    readiness: deps.readiness,
    webhook: handlers,
  });
}
