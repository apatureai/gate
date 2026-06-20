import { DEFAULT_CONFIG } from "@gate/config";
import type { CheckRun, GitHubCommentsApi } from "@gate/delivery";
import type { JudgmentEngineClient } from "@gate/engine";
import type { NormalizedDesignReviewConfig } from "@gate/types";
import type { FastifyInstance } from "fastify";
import { createAppServer, type AppServerDeps } from "./app-server.js";
import type { FeedbackSink } from "./feedback-routes.js";
import { type DeploymentHandlerDeps, runHostedReview } from "./hosted-review.js";
import { hydrateReviewContext, type PullRequestFetcher } from "./hydrate.js";
import type { ReviewJobPayload } from "./queue.js";
import type { FullReviewWindowStore } from "./review-window.js";
import { runStartupChecks, type StartupCheckDeps } from "./startup.js";
import type { SupersessionStore } from "./supersession.js";
import type { WebhookDedupeStore } from "./webhook-dedup.js";
import type { ReviewJobWorker } from "./worker.js";

/**
 * Live App-path composition root (#62). `createAppServer` (#1/#2/#49) wires the
 * webhook receiver to enqueue/supersede, but nothing assembled the **worker**:
 * a deployed machine received webhooks and did no reviews. This binds
 * `worker.onJob` to the full hosted pipeline — hydrate the IDs-only payload
 * (#3) with the PR's details, then `runHostedReview` (#23/#4/#38) with the
 * per-installation GitHub + engine clients and the supersession abort signal
 * (#48) — and runs the boot invariant checks (#34) before listening.
 *
 * Infra-bound clients (installation tokens, the per-account engine transport,
 * SQL/Redis stores) are injected, so this is testable end-to-end with fakes + a
 * mock engine; the real construction from env/secrets is the go-live ops step
 * (#64) in `server.ts`.
 */

/** Per-installation GitHub + engine clients, built from the installation token. */
export interface InstallationClients {
  fetchPullRequest: PullRequestFetcher["fetchPullRequest"];
  comments: GitHubCommentsApi;
  publishCheckRun(run: CheckRun): Promise<void>;
  engine: JudgmentEngineClient;
}

export interface ProductionAppServerDeps {
  /** GitHub webhook HMAC secret (#2). */
  webhookSecret: string;
  supersession: SupersessionStore;
  worker: ReviewJobWorker;
  windowStore: FullReviewWindowStore;
  /** Resolve the open PR for a deployment SHA (installation-authed lookup, #55). */
  resolvePullRequest: DeploymentHandlerDeps["resolvePullRequest"];
  /** Build the per-installation GitHub + engine clients for a job. */
  installationClients(job: ReviewJobPayload): InstallationClients | Promise<InstallationClients>;
  /** Per-repo `.designreview.yml` (#27); defaults to `DEFAULT_CONFIG`. */
  loadConfig?(job: ReviewJobPayload): NormalizedDesignReviewConfig | Promise<NormalizedDesignReviewConfig>;
  feedback?: FeedbackSink;
  webhookDedupe?: WebhookDedupeStore;
  /** Preview environment to match on `deployment_status` (#55). */
  environment?: string;
  isDuplicate?: DeploymentHandlerDeps["isDuplicate"];
  /** Readiness probe (`/readyz`): are downstream deps reachable? */
  readiness?: () => boolean | Promise<boolean>;
  /** Boot invariant checks (Redis `noeviction`, #34); run before `listen`. */
  startup?: StartupCheckDeps;
  /** Build the dashboard run URL for a job's Check Run details link. */
  runUrl?(job: ReviewJobPayload): string | undefined;
  now?: () => number;
  logger?: boolean;
}

export interface ProductionAppServer {
  server: FastifyInstance;
  /** Run startup invariant checks, then begin listening. Failure exits non-zero. */
  start(opts: { host?: string; port: number }): Promise<void>;
}

export function createProductionAppServer(deps: ProductionAppServerDeps): ProductionAppServer {
  // Bind the worker to the hosted pipeline. The queue payload is IDs/refs only
  // (#3), so hydrate the PR details first, then run the review with the
  // per-installation clients and the supersession abort signal (#48).
  deps.worker.onJob(async (job, ctx) => {
    const clients = await deps.installationClients(job);
    const details = await clients.fetchPullRequest(job.owner, job.name, job.prNumber);
    if (!details) return; // PR closed / head gone — nothing to review
    const reviewCtx = hydrateReviewContext(job, details);
    const config = (await deps.loadConfig?.(job)) ?? DEFAULT_CONFIG;
    await runHostedReview(config, reviewCtx, {
      supersession: deps.supersession,
      windowStore: deps.windowStore,
      engine: clients.engine,
      comments: clients.comments,
      publishCheckRun: clients.publishCheckRun,
      feedback: deps.feedback,
      signal: ctx.signal,
      runUrl: deps.runUrl?.(job),
      now: deps.now,
    });
  });

  const appDeps: AppServerDeps = {
    webhookSecret: deps.webhookSecret,
    supersession: deps.supersession,
    worker: deps.worker,
    resolvePullRequest: deps.resolvePullRequest,
    environment: deps.environment,
    isDuplicate: deps.isDuplicate,
    webhookDedupe: deps.webhookDedupe,
    readiness: deps.readiness,
    logger: deps.logger,
  };
  const server = createAppServer(appDeps);

  return {
    server,
    async start({ host = "0.0.0.0", port }) {
      // Fail fast if a boot invariant is violated (e.g. Redis eviction would let
      // the publish-time SHA guard read nil and pass a stale SHA, §15.3).
      if (deps.startup) await runStartupChecks(deps.startup);
      await server.listen({ host, port });
    },
  };
}
