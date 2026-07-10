import { DEFAULT_CONFIG } from "@gate/config";
import { setupFailureCheckRun, type CheckRun, type GitHubCommentsApi } from "@gate/delivery";
import type { JudgmentEngineClient } from "@gate/engine";
import type { NormalizedDesignReviewConfig } from "@gate/types";
import type { FastifyInstance } from "fastify";
import { createAppServer, type AppServerDeps } from "./app-server.js";
import {
  registerFeedbackRoutes,
  type FeedbackRouteOptions,
  type FeedbackSink,
} from "./feedback-routes.js";
import { type DeploymentHandlerDeps, runHostedReview } from "./hosted-review.js";
import { hydrateReviewContext, type PullRequestFetcher } from "./hydrate.js";
import type { ReviewJobPayload } from "./queue.js";
import { READINESS_CEILING_MS, waitForReadiness } from "./readiness.js";
import type { ReadinessOptions, ReadinessResult } from "@gate/engine";
import type { FullReviewWindowStore } from "./review-window.js";
import type { RunStore } from "./run-store.js";
import {
  registerScreenshotRoute,
  type ScreenshotRegistryWriter,
  type ScreenshotRouteOptions,
  type ScreenshotVisibility,
} from "./screenshots.js";
import { runStartupChecks, type StartupCheckDeps } from "./startup.js";
import { assertProductionEnv } from "./production-readiness.js";
import { currentShaKey, guardPublish, type SupersessionStore } from "./supersession.js";
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
  /** Durable completed-run store (#69); persists runs + the deep full-review window. */
  runStore?: RunStore;
  /** Durable screenshot artifact registry (#71); also used by the mounted /i route. */
  screenshotRegistry?: ScreenshotRegistryWriter;
  /** Hosted App artifacts default to private; override only for explicit public/OSS policy. */
  screenshotVisibility?: ScreenshotVisibility;
  /** Route deps for GET /i/:artifactId.png; requires screenshotRegistry. */
  screenshotRoute?: Omit<ScreenshotRouteOptions, "registry">;
  /** Resolve the open PR for a deployment SHA (installation-authed lookup, #55). */
  resolvePullRequest: DeploymentHandlerDeps["resolvePullRequest"];
  /** Build the per-installation GitHub + engine clients for a job. */
  installationClients(job: ReviewJobPayload): InstallationClients | Promise<InstallationClients>;
  /** Per-repo `.designreview.yml` (#27); defaults to `DEFAULT_CONFIG`. */
  loadConfig?(job: ReviewJobPayload): NormalizedDesignReviewConfig | Promise<NormalizedDesignReviewConfig>;
  /** Preview readiness gate before engine handoff (#149); defaults to shared waitForReadiness. */
  previewReadiness?(options: ReadinessOptions): Promise<ReadinessResult>;
  feedback?: FeedbackSink;
  /** Route deps for /feedback/confirm and POST /feedback. */
  feedbackRoutes?: FeedbackRouteOptions;
  webhookDedupe?: WebhookDedupeStore;
  /** Preview environment to match on `deployment_status` (#55). */
  environment?: string;
  isDuplicate?: DeploymentHandlerDeps["isDuplicate"];
  /** Readiness probe (`/readyz`): are downstream deps reachable? */
  readiness?: () => boolean | Promise<boolean>;
  /** Boot invariant checks (Redis `noeviction`, #34); run before `listen`. */
  startup?: StartupCheckDeps;
  /**
   * When set, fail fast at `start()` if any required production env var is missing
   * (#64). Pass `process.env` from the composition root to enforce; omit in
   * tests/dev. Custom `requiredEnv` overrides the default `PRODUCTION_ENV_VARS`.
   */
  env?: NodeJS.ProcessEnv;
  requiredEnv?: readonly string[];
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
    let config: NormalizedDesignReviewConfig;
    try {
      config = (await deps.loadConfig?.(job)) ?? DEFAULT_CONFIG;
    } catch (err) {
      const key = currentShaKey({ owner: job.owner, name: job.name, prNumber: job.prNumber });
      if (await guardPublish(deps.supersession, key, job.headSha)) {
        await clients.publishCheckRun(setupFailureCheckRun(err, "App"));
      }
      return;
    }
    const readiness = await (deps.previewReadiness ?? waitForReadiness)({
      url: job.previewUrl,
      waitSeconds: config.preview.waitSeconds,
      signal: ctx.signal,
    });
    if (!readiness.ready) {
      if (readiness.reason === "aborted") return;
      const key = currentShaKey({ owner: job.owner, name: job.name, prNumber: job.prNumber });
      if (!(await guardPublish(deps.supersession, key, job.headSha))) return;
      await clients.publishCheckRun({
        name: "Apature Gate",
        conclusion: "neutral",
        title: "Preview not ready",
        summary: readinessFailureSummary(job.previewUrl, readiness),
      });
      return;
    }
    await runHostedReview(config, reviewCtx, {
      supersession: deps.supersession,
      windowStore: deps.windowStore,
      engine: clients.engine,
      comments: clients.comments,
      publishCheckRun: clients.publishCheckRun,
      runStore: deps.runStore,
      screenshotRegistry: deps.screenshotRegistry,
      screenshotVisibility: deps.screenshotVisibility,
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
  if (deps.screenshotRegistry && deps.screenshotRoute) {
    registerScreenshotRoute(server, { registry: deps.screenshotRegistry, ...deps.screenshotRoute });
  }
  if (deps.feedbackRoutes) {
    registerFeedbackRoutes(server, deps.feedbackRoutes);
  }

  return {
    server,
    async start({ host = "0.0.0.0", port }) {
      // Fail fast if a required production env var is missing (#64) — one
      // aggregated error, before any connection is attempted.
      if (deps.env) assertProductionEnv(deps.env, deps.requiredEnv);
      // Fail fast if a boot invariant is violated (e.g. Redis eviction would let
      // the publish-time SHA guard read nil and pass a stale SHA, §15.3).
      if (deps.startup) await runStartupChecks(deps.startup);
      await server.listen({ host, port });
    },
  };
}

function readinessFailureSummary(
  url: string,
  result: Extract<ReadinessResult, { ready: false }>,
): string {
  if (result.reason === "child_exited") {
    return "The preview process exited before the hosted review could start. Not reviewed.";
  }
  return `Preview did not respond with HTTP 200 at ${url} within ${Math.round(
    READINESS_CEILING_MS / 1000,
  )}s. Not reviewed.`;
}
