import { pathToFileURL } from "node:url";
import { pgExecutor, pgTenantRunner, type QueryFn, type TenantTxRunner } from "@gate/db";
import { createJudgmentEngineClient, createAccountEngineTransport, type JudgmentEngineClient } from "@gate/engine";
import { createRedisConnection, type RedisConfigClient } from "@gate/redis";
import { EnvSecretStore, type SecretStore } from "@gate/secrets";
import { Pool } from "pg";
import { createGitHubAppAuth, type GitHubAppAuth } from "./app-auth.js";
import { createAppReviewClient, type AppReviewClient, type AppReviewTarget } from "./app-github.js";
import { createFeedbackSink, createSqlFeedbackStore } from "./feedback-store.js";
import { createSqlConsumedStore } from "./feedback-token.js";
import type { FeedbackSink } from "./feedback-routes.js";
import { createGitHubPullsClient, type GitHubPullsClient } from "./github-pulls.js";
import {
  createProductionAppServer,
  type ProductionAppServer,
  type ProductionAppServerDeps,
} from "./production-server.js";
import { assertProductionEnv } from "./production-readiness.js";
import { createGitHubRepoConfigClient, type RepoConfigClient } from "./repo-config.js";
import { createSqlFullReviewWindow, type FullReviewWindowStore, type SqlQuery } from "./review-window.js";
import { createSqlRunStore, type CompletedRunRecord, type RunStore } from "./run-store.js";
import { createSqlScreenshotRegistry, createTemplateSignedUrlProvider } from "./screenshots.js";
import { createBullReviewWorker } from "./worker.js";
import { createSqlWebhookDedupe } from "./webhook-dedup.js";
import { createRedisSupersessionStore, type RedisLike, type RepoPr } from "./supersession.js";

/**
 * Process entrypoint used by the container (`fly.toml` CMD). The live App-path is
 * assembled by `createProductionAppServer` (#62); this entrypoint only builds the
 * infra-bound deps from the environment and starts listening.
 *
 * Constructing those deps — the KMS-backed `SecretStore` -> `createGitHubAppAuth`
 * -> per-installation `createAppReviewClient`/`createGitHubPullsClient`, the
 * per-account engine transport, and the Redis/SQL stores -> requires live
 * Postgres/Redis/Fly/secrets and is the **go-live ops step (#64)**: wire
 * `buildProductionDepsFromEnv` to the provisioned services there. Keeping it one
 * clearly-marked seam (not scattered `process.env` reads) keeps the composition
 * root above fully testable with fakes + a mock engine.
 */
export interface SqlRuntime {
  query: SqlQuery;
  tenant: TenantTxRunner;
  close?(): Promise<void>;
}

export interface RedisRuntime extends RedisLike, RedisConfigClient {
  quit?(): Promise<unknown>;
}

export interface ProductionRuntimeFactories {
  secretStore?(env: NodeJS.ProcessEnv): SecretStore;
  sql?(databaseUrl: string): SqlRuntime;
  redis?(redisUrl: string): RedisRuntime;
  reviewWorker?(redisUrl: string): ProductionAppServerDeps["worker"];
  githubAuth?(opts: { appId: string; privateKey: string }): GitHubAppAuth;
  githubPullsClient?(token: string): GitHubPullsClient;
  repoConfigClient?(token: string): RepoConfigClient;
  appReviewClient?(token: string, target: AppReviewTarget): AppReviewClient;
  engineClient?(opts: { hostedEndpoint: string; apiKey: string; hmacSecret: string }): JudgmentEngineClient;
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`Production readiness: missing required environment variable(s): ${name}. Set them before go-live (see docs/go-live.md, #64).`);
  }
  return value;
}

function createPgRuntime(databaseUrl: string): SqlRuntime {
  const pool = new Pool({ connectionString: databaseUrl });
  const exec = pgExecutor(pool);
  return {
    query: exec.query,
    tenant: pgTenantRunner(pool),
    close: () => pool.end(),
  };
}

function installationIdOf(repo: RepoPr): string {
  const installationId = (repo as RepoPr & { installationId?: string }).installationId;
  if (!installationId) {
    throw new Error("tenant-scoped review window requires installationId");
  }
  return installationId;
}

function createTenantFullReviewWindow(tenant: TenantTxRunner): FullReviewWindowStore {
  return {
    async getLastFullReviewAt(repo) {
      return tenant.withTenant(installationIdOf(repo), (q) => createSqlFullReviewWindow(q).getLastFullReviewAt(repo));
    },
    async recordFullReview(repo, atMs) {
      await tenant.withTenant(installationIdOf(repo), (q) => createSqlFullReviewWindow(q).recordFullReview(repo, atMs));
    },
  };
}

function createTenantRunStore(tenant: TenantTxRunner): RunStore {
  return {
    async recordCompletedRun(run: CompletedRunRecord) {
      await tenant.withTenant(run.installationId, (q: QueryFn) => createSqlRunStore(q).recordCompletedRun(run));
    },
  };
}

function createTenantFeedbackSink(tenant: TenantTxRunner): FeedbackSink {
  return createFeedbackSink({
    async persist(event) {
      await tenant.withTenant(event.installationId, (q: QueryFn) => createSqlFeedbackStore(q).persist(event));
    },
  });
}

export async function buildProductionDepsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  factories: ProductionRuntimeFactories = {},
): Promise<ProductionAppServerDeps> {
  assertProductionEnv(env);
  const secretStore = factories.secretStore?.(env) ?? new EnvSecretStore(env);
  const databaseUrl = requiredEnv(env, "DATABASE_URL");
  const redisUrl = requiredEnv(env, "REDIS_URL");
  const appId = requiredEnv(env, "GITHUB_APP_ID");
  const sql = factories.sql?.(databaseUrl) ?? createPgRuntime(databaseUrl);
  const redis = factories.redis?.(redisUrl) ?? (createRedisConnection(redisUrl) as unknown as RedisRuntime);
  const privateKey = await secretStore.get("githubAppPrivateKey");
  const auth =
    factories.githubAuth?.({ appId, privateKey }) ??
    createGitHubAppAuth({ appId, privateKey });
  const hostedEndpoint = await secretStore.get("engineEndpoint");
  const engineApiKey = await secretStore.get("engineApiKey");
  const engineHmacSecret = await secretStore.get("engineHmacSecret");
  const screenshotRegistry = createSqlScreenshotRegistry(sql.query);
  const screenshotObjectUrlTemplate = requiredEnv(env, "GATE_SCREENSHOT_OBJECT_URL_TEMPLATE");
  const screenshotCapabilitySecret = requiredEnv(env, "SCREENSHOT_CAPABILITY_SECRET");
  const feedbackTokenSecret = requiredEnv(env, "FEEDBACK_TOKEN_SECRET");
  const feedback = createTenantFeedbackSink(sql.tenant);
  const githubPullsClient = factories.githubPullsClient ?? ((token: string) => createGitHubPullsClient(token));
  const repoConfigClient = factories.repoConfigClient ?? ((token: string) => createGitHubRepoConfigClient(token));
  const appReviewClient =
    factories.appReviewClient ?? ((token: string, target: AppReviewTarget) => createAppReviewClient(token, target));
  const engineClient =
    factories.engineClient ??
    ((opts: { hostedEndpoint: string; apiKey: string; hmacSecret: string }) => {
      const { transport } = createAccountEngineTransport(
        {},
        { hostedEndpoint: opts.hostedEndpoint, apiKey: opts.apiKey, hmacSecret: opts.hmacSecret },
      );
      return createJudgmentEngineClient(transport);
    });

  return {
    webhookSecret: await secretStore.get("webhookSecret"),
    supersession: createRedisSupersessionStore(redis),
    worker: factories.reviewWorker?.(redisUrl) ?? createBullReviewWorker(redisUrl),
    windowStore: createTenantFullReviewWindow(sql.tenant),
    runStore: createTenantRunStore(sql.tenant),
    screenshotRegistry,
    screenshotRoute: {
      signer: createTemplateSignedUrlProvider(screenshotObjectUrlTemplate),
      capabilitySecret: screenshotCapabilitySecret,
    },
    feedback,
    feedbackRoutes: {
      secret: feedbackTokenSecret,
      sink: feedback,
      consumed: createSqlConsumedStore(sql.query),
    },
    webhookDedupe: createSqlWebhookDedupe(sql.query),
    startup: { redis },
    shutdown: {
      closeRedis: async () => {
        await redis.quit?.();
      },
      closeSql: async () => {
        await sql.close?.();
      },
    },
    env,
    resolvePullRequest: async (owner, name, sha, installationId) => {
      const token = await auth.getInstallationToken(installationId);
      return githubPullsClient(token).resolvePullRequest(owner, name, sha);
    },
    loadConfig: async (job) => {
      const token = await auth.getInstallationToken(Number(job.installationId));
      return repoConfigClient(token).loadConfig(job.owner, job.name, job.headSha);
    },
    installationClients: async (job) => {
      const token = await auth.getInstallationToken(Number(job.installationId));
      const pulls = githubPullsClient(token);
      const review = appReviewClient(token, {
        owner: job.owner,
        name: job.name,
        prNumber: job.prNumber,
        headSha: job.headSha,
      });
      return {
        fetchPullRequest: pulls.fetchPullRequest,
        comments: review.comments,
        publishCheckRun: review.publishCheckRun,
        engine: engineClient({ hostedEndpoint, apiKey: engineApiKey, hmacSecret: engineHmacSecret }),
      };
    },
  };
}

function isEntrypoint(): boolean {
  const entry = process.argv[1];
  return !!entry && import.meta.url === pathToFileURL(entry).href;
}

type ShutdownSignal = "SIGTERM" | "SIGINT";

export interface SignalSource {
  exitCode?: string | number | null;
  once(event: ShutdownSignal, listener: () => void): unknown;
  off(event: ShutdownSignal, listener: () => void): unknown;
}

/**
 * Bind both container shutdown signals to the composition-owned drain. The
 * listener never calls process.exit(); setting exitCode lets Node leave only
 * after Fastify, BullMQ, Redis, and Postgres have released their handles.
 */
export function installProductionSignalHandlers(
  app: Pick<ProductionAppServer, "stop">,
  signalSource: SignalSource = process,
  onError: (error: unknown) => void = console.error,
): () => void {
  let registered = true;
  const remove = (): void => {
    if (!registered) return;
    registered = false;
    signalSource.off("SIGTERM", handleSignal);
    signalSource.off("SIGINT", handleSignal);
  };
  const handleSignal = (): void => {
    remove();
    void app.stop().then(
      () => {
        if (signalSource.exitCode == null) signalSource.exitCode = 0;
      },
      (error: unknown) => {
        signalSource.exitCode = 1;
        onError(error);
      },
    );
  };

  signalSource.once("SIGTERM", handleSignal);
  signalSource.once("SIGINT", handleSignal);
  return remove;
}

if (isEntrypoint()) {
  const port = Number(process.env.PORT ?? 8080);
  buildProductionDepsFromEnv()
    .then(async (deps) => {
      const app = createProductionAppServer(deps);
      const removeSignalHandlers = installProductionSignalHandlers(app);
      try {
        await app.start({ host: "0.0.0.0", port });
      } catch (error) {
        removeSignalHandlers();
        await app.stop().catch(() => undefined);
        throw error;
      }
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
}
