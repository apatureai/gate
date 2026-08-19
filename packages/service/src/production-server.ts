import { ConfigValidationError, DEFAULT_CONFIG } from "@gate/config";
import {
  setupFailureCheckRun,
  type CheckRun,
  type GitHubCommentsApi,
  type MeasurementBaselineStore,
} from "@gate/delivery";
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
 * `worker.onJob` to the full hosted pipeline: hydrate the IDs-only payload
 * (#3) with the PR's details, then `runHostedReview` (#23/#4/#38) with the
 * per-installation GitHub + engine clients and the supersession abort signal
 * (#48). It also runs the boot invariant checks (#34) before listening.
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
  /**
   * Durable per-commit measurement sets: read for a pull request's base, written
   * for its head, and carried onto a merge commit whose tree is identical to the
   * head that was reviewed. Without it every measurement is unclassified and
   * `rules.measurements: block` fails nothing, which every run says out loud.
   */
  measurementBaselines?: MeasurementBaselineStore;
  /**
   * Commit-tree lookup for the merge carry-forward. Reads
   * `git/commits/{sha}` under the App's existing `contents: read`; absent means
   * merges carry nothing forward, because a copy Gate cannot justify by tree
   * equality is one it must not make.
   */
  commits?: DeploymentHandlerDeps["commits"];
  /**
   * Capture-and-measure with no model call, used by the `push` handler to record
   * a baseline for every commit that lands on the default branch. Absent means
   * pushes record nothing; there is deliberately no fallback to the review
   * client, because a fallback would bill a model call per push.
   */
  measure?: DeploymentHandlerDeps["measure"];
  /**
   * The repository's `.gate.yml` at a default-branch commit, for the push
   * handler. Separate from `loadConfig`, which is keyed by a queued review job:
   * a push has no pull request and no job. Absent falls back to `DEFAULT_CONFIG`,
   * whose `preview.default_branch_url` is null, so nothing is measured.
   */
  loadDefaultBranchConfig?: DeploymentHandlerDeps["loadConfig"];
  /** Resolve the open PR for a deployment SHA (installation-authed lookup, #55). */
  resolvePullRequest: DeploymentHandlerDeps["resolvePullRequest"];
  /** Build the per-installation GitHub + engine clients for a job. */
  installationClients(job: ReviewJobPayload): InstallationClients | Promise<InstallationClients>;
  /** Per-repo `.gate.yml` (#27); defaults to `DEFAULT_CONFIG`. */
  loadConfig?(job: ReviewJobPayload): NormalizedDesignReviewConfig | Promise<NormalizedDesignReviewConfig>;
  /**
   * Component-library ids from the repository's `package.json` at the job's
   * head, forwarded to the engine as prompt grounding. Optional: unset means
   * the review is grounded on tokens and brand, which is what every hosted
   * review was grounded on before the engine's contract could carry this.
   *
   * It must never throw: detection is grounding, not a precondition, and a
   * GitHub read that fails has to cost the review its addenda and nothing more.
   */
  componentLibraries?(job: ReviewJobPayload): Promise<string[]>;
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
  /** Infra handles owned by the production composition root, in close order. */
  shutdown?: {
    closeRedis?(): Promise<void>;
    closeSql?(): Promise<void>;
  };
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
  /** Stop HTTP admission, drain the worker/queue, then close Redis and SQL. */
  stop(): Promise<void>;
}

export function createProductionAppServer(deps: ProductionAppServerDeps): ProductionAppServer {
  // Bind the worker to the hosted pipeline. The queue payload is IDs/refs only
  // (#3), so hydrate the PR details first, then run the review with the
  // per-installation clients and the supersession abort signal (#48).
  deps.worker.onJob(async (job, ctx) => {
    const clients = await deps.installationClients(job);
    const details = await clients.fetchPullRequest(job.owner, job.name, job.prNumber);
    if (!details) return; // PR closed / head gone, nothing to review
    const reviewCtx = hydrateReviewContext(job, details);
    let config: NormalizedDesignReviewConfig;
    let readinessUrl: string;
    try {
      config = (await deps.loadConfig?.(job)) ?? DEFAULT_CONFIG;
      readinessUrl = resolveReadinessUrl(job.previewUrl, config.preview.readyPath);
    } catch (err) {
      const key = currentShaKey({ owner: job.owner, name: job.name, prNumber: job.prNumber });
      if (await guardPublish(deps.supersession, key, job.headSha)) {
        await clients.publishCheckRun(setupFailureCheckRun(err, "App"));
      }
      return;
    }
    const acceptStatus = configuredStatusPredicate(config.preview.readyStatus);
    const readiness = await (deps.previewReadiness ?? waitForReadiness)({
      url: readinessUrl,
      waitSeconds: config.preview.waitSeconds,
      signal: ctx.signal,
      ...(acceptStatus ? { acceptStatus } : {}),
    });
    if (!readiness.ready) {
      if (readiness.reason === "aborted") return;
      const key = currentShaKey({ owner: job.owner, name: job.name, prNumber: job.prNumber });
      if (!(await guardPublish(deps.supersession, key, job.headSha))) return;
      await clients.publishCheckRun({
        name: "Apature Gate",
        conclusion: "neutral",
        title: "Preview not ready",
        summary: readinessFailureSummary(readinessUrl, readiness, config.preview.readyStatus),
      });
      return;
    }
    // Grounding, resolved after readiness so a preview that never came up costs
    // no GitHub call. Detection failures are already swallowed by the client, so
    // an empty list here means "nothing to add", never "the review failed".
    const componentLibraries = (await deps.componentLibraries?.(job)) ?? [];
    await runHostedReview(
      config,
      componentLibraries.length > 0 ? { ...reviewCtx, componentLibraries } : reviewCtx,
      {
        supersession: deps.supersession,
        windowStore: deps.windowStore,
        engine: clients.engine,
        comments: clients.comments,
        publishCheckRun: clients.publishCheckRun,
        runStore: deps.runStore,
        screenshotRegistry: deps.screenshotRegistry,
        measurementBaselines: deps.measurementBaselines,
        screenshotVisibility: deps.screenshotVisibility,
        feedback: deps.feedback,
        signal: ctx.signal,
        runUrl: deps.runUrl?.(job),
        now: deps.now,
      },
    );
  });

  const appDeps: AppServerDeps = {
    webhookSecret: deps.webhookSecret,
    supersession: deps.supersession,
    worker: deps.worker,
    resolvePullRequest: deps.resolvePullRequest,
    measurementBaselines: deps.measurementBaselines,
    commits: deps.commits,
    measure: deps.measure,
    loadConfig: deps.loadDefaultBranchConfig,
    now: deps.now,
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

  let startPromise: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;

  return {
    server,
    start({ host = "0.0.0.0", port }) {
      if (stopPromise) return Promise.reject(new Error("production server is stopping"));
      startPromise ??= (async () => {
        // Fail fast if a required production env var is missing (#64): one
        // aggregated error, before any connection is attempted.
        if (deps.env) assertProductionEnv(deps.env, deps.requiredEnv);
        // Fail fast if a boot invariant is violated (e.g. Redis eviction would let
        // the publish-time SHA guard read nil and pass a stale SHA, §15.3).
        if (deps.startup) await runStartupChecks(deps.startup);
        // A signal may arrive while startup checks are running. In that case the
        // stop path owns cleanup and the socket must never begin admitting work.
        if (stopPromise) return;
        await server.listen({ host, port });
      })();
      return startPromise;
    },
    stop() {
      stopPromise ??= (async () => {
        // If startup is in progress, let it either fail or observe stopPromise
        // before closing resources. This prevents listen-after-stop races.
        await startPromise?.catch(() => undefined);
        const errors: unknown[] = [];
        const close = async (fn: (() => Promise<void>) | undefined): Promise<void> => {
          if (!fn) return;
          try {
            await fn();
          } catch (error) {
            errors.push(error);
          }
        };

        // Order is load-bearing: stop HTTP admission first, then work, then the
        // backing stores used by that work. Continue closing after any failure.
        await close(() => server.close());
        await close(deps.worker.close?.bind(deps.worker));
        await close(deps.shutdown?.closeRedis?.bind(deps.shutdown));
        await close(deps.shutdown?.closeSql?.bind(deps.shutdown));

        if (errors.length > 0) {
          throw new AggregateError(errors, "production server shutdown failed");
        }
      })();
      return stopPromise;
    },
  };
}

function resolveReadinessUrl(previewUrl: string, readyPath: string | null): string {
  if (!readyPath) return previewUrl;
  const preview = new URL(previewUrl);
  const readiness = new URL(readyPath, preview);
  if (readiness.origin !== preview.origin) {
    throw new ConfigValidationError([
      "preview.ready_path: must resolve on the configured preview origin",
    ]);
  }
  return readiness.toString();
}

function configuredStatusPredicate(
  readyStatus: number[] | null,
): ((status: number) => boolean) | undefined {
  if (readyStatus === null) return undefined;
  const accepted = new Set(readyStatus);
  return (status) => accepted.has(status);
}

function readinessFailureSummary(
  url: string,
  result: Extract<ReadinessResult, { ready: false }>,
  readyStatus: number[] | null,
): string {
  if (result.reason === "child_exited") {
    return "The preview process exited before the hosted review could start. Not reviewed.";
  }
  const expectedStatus = readyStatus === null
    ? "HTTP 200"
    : `an accepted HTTP status (${readyStatus.join(", ") || "none configured"})`;
  return `Preview did not respond with ${expectedStatus} at ${url} within ${Math.round(
    READINESS_CEILING_MS / 1000,
  )}s. Not reviewed.`;
}
