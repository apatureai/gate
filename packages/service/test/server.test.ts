import { EventEmitter } from "node:events";
import type { CheckRun, GitHubCommentsApi } from "@gate/delivery";
import type { JudgmentEngineClient } from "@gate/engine";
import type { QueryFn, TenantTxRunner } from "@gate/db";
import { describe, expect, it, vi } from "vitest";
import type { GitHubAppAuth } from "../src/app-auth.js";
import { buildFeedbackEvent } from "../src/feedback-store.js";
import type { AppReviewClient, AppReviewTarget } from "../src/app-github.js";
import type { GitHubPullsClient } from "../src/github-pulls.js";
import { PRODUCTION_ENV_VARS } from "../src/production-readiness.js";
import type { RepoConfigClient } from "../src/repo-config.js";
import {
  buildProductionDepsFromEnv,
  installProductionSignalHandlers,
  type ProductionRuntimeFactories,
} from "../src/server.js";

function fullEnv(): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(PRODUCTION_ENV_VARS.map((name) => [name, `value-for-${name}`])),
    DATABASE_URL: "postgres://example/db",
    REDIS_URL: "redis://example",
    GITHUB_APP_ID: "12345",
    JUDGMENT_ENGINE_ENDPOINT: "https://engine.example",
    JUDGMENT_ENGINE_API_KEY: "engine-key",
    JUDGMENT_ENGINE_HMAC_SECRET: "hmac-secret",
    GATE_SCREENSHOT_OBJECT_URL_TEMPLATE: "https://objects.example/{objectKey}?signed=1",
    SCREENSHOT_CAPABILITY_SECRET: "cap-secret",
    FEEDBACK_TOKEN_SECRET: "feedback-secret",
  };
}

function fakeComments(): GitHubCommentsApi {
  return {
    listComments: vi.fn(async () => []),
    createComment: vi.fn(async (body) => ({ id: 1, nodeId: "n1", body })),
    updateComment: vi.fn(async () => ({ updated: true })),
  };
}

function baseFactories(overrides: Partial<ProductionRuntimeFactories> = {}): ProductionRuntimeFactories {
  const query: QueryFn = vi.fn(async () => ({ rows: [] }));
  const tenant: TenantTxRunner = {
    withTenant: vi.fn(async (_installationId, fn) => fn(query)),
  };
  const auth: GitHubAppAuth = {
    getInstallationToken: vi.fn(async (installationId) => `token-${installationId}`),
    mintAppJwt: vi.fn(async () => "jwt"),
  };
  return {
    sql: vi.fn(() => ({ query, tenant })),
    redis: vi.fn(() => ({
      set: vi.fn(async () => undefined),
      get: vi.fn(async () => null),
      config: vi.fn(async () => ["maxmemory-policy", "noeviction"]),
    })),
    reviewWorker: vi.fn(() => ({
      enqueue: vi.fn(async () => "job"),
      cancel: vi.fn(async () => undefined),
      onJob: vi.fn(),
    })),
    githubAuth: vi.fn(() => auth),
    githubPullsClient: vi.fn(
      (token): GitHubPullsClient => ({
        fetchPullRequest: vi.fn(async () => ({
          defaultBranch: "main",
          title: `fetched by ${token}`,
          body: null,
          isFork: false,
        })),
        resolvePullRequest: vi.fn(async () => ({ number: 42, headSha: "sha", baseSha: "base" })),
      }),
    ),
    repoConfigClient: vi.fn(
      (token): RepoConfigClient => ({
        loadConfig: vi.fn(async () => ({
          preview: {
            source: "auto",
            environment: "Preview",
            urlTemplate: null,
            waitSeconds: 0,
            readySelector: null,
            readyPath: null,
            readyStatus: null,
            protectionBypassSecretName: null,
            authStateSecretName: null,
            forkPreview: false,
          },
          routes: { always: ["/"], maxPerPr: 5, map: {} },
          viewports: ["mobile", "desktop"],
          darkMode: false,
          brand: `loaded by ${token}`,
          rules: { gate: "none", minSeverityToComment: "nit", suppress: [] },
          tokens: { source: null, values: {} },
        })),
      }),
    ),
    appReviewClient: vi.fn(
      (_token: string, _target: AppReviewTarget): AppReviewClient => ({
        comments: fakeComments(),
        publishCheckRun: vi.fn(async (_run: CheckRun) => undefined),
      }),
    ),
    engineClient: vi.fn(
      (): JudgmentEngineClient => ({
        review: vi.fn(async () => ({ status: "not_reviewed", reason: "preview_unavailable", detail: "test" })),
        cancel: vi.fn(async () => undefined),
      }),
    ),
    ...overrides,
  };
}

describe("buildProductionDepsFromEnv", () => {
  it("fails fast with one aggregated missing-env error before constructing deps", async () => {
    const env = fullEnv();
    delete env.GITHUB_APP_ID;
    delete env.REDIS_URL;
    await expect(buildProductionDepsFromEnv(env, baseFactories())).rejects.toThrow(/GITHUB_APP_ID/);
    await expect(buildProductionDepsFromEnv(env, baseFactories())).rejects.toThrow(/REDIS_URL/);
  });

  it("wraps SQL run/window stores in the tenant runner so RLS has an installation scope", async () => {
    const tenantIds: string[] = [];
    const query: QueryFn = vi.fn(async () => ({ rows: [] }));
    const tenant: TenantTxRunner = {
      withTenant: vi.fn(async (installationId, fn) => {
        tenantIds.push(String(installationId));
        return fn(query);
      }),
    };
    const deps = await buildProductionDepsFromEnv(fullEnv(), baseFactories({ sql: () => ({ query, tenant }) }));

    await deps.windowStore.getLastFullReviewAt({
      installationId: "99",
      owner: "acme",
      name: "web",
      prNumber: 42,
    } as Parameters<typeof deps.windowStore.getLastFullReviewAt>[0] & { installationId: string });
    await deps.runStore?.recordCompletedRun({
      installationId: "99",
      owner: "acme",
      name: "web",
      prNumber: 42,
      headSha: "sha",
      grade: "ship",
      depth: "deep",
    });

    expect(tenantIds).toEqual(["99", "99"]);
  });

  it("wires the owned Redis and SQL handles into the shutdown chain", async () => {
    const closeSql = vi.fn(async () => undefined);
    const quitRedis = vi.fn(async () => "OK");
    const query: QueryFn = vi.fn(async () => ({ rows: [] }));
    const tenant: TenantTxRunner = {
      withTenant: vi.fn(async (_installationId, fn) => fn(query)),
    };
    const deps = await buildProductionDepsFromEnv(
      fullEnv(),
      baseFactories({
        sql: () => ({ query, tenant, close: closeSql }),
        redis: () => ({
          set: vi.fn(async () => undefined),
          get: vi.fn(async () => null),
          config: vi.fn(async () => ["maxmemory-policy", "noeviction"]),
          quit: quitRedis,
        }),
      }),
    );

    await deps.shutdown?.closeRedis?.();
    await deps.shutdown?.closeSql?.();

    expect(quitRedis).toHaveBeenCalledOnce();
    expect(closeSql).toHaveBeenCalledOnce();
  });

  it("reports production readiness only when Postgres and Redis are reachable", async () => {
    const query: QueryFn = vi.fn(async () => ({ rows: [] }));
    const redisGet = vi.fn(async () => null as string | null);
    const factories = baseFactories({
      sql: vi.fn(() => ({
        query,
        tenant: {
          withTenant: vi.fn(async (_installationId, fn) => fn(query)),
        },
      })),
      redis: vi.fn(() => ({
        set: vi.fn(async () => undefined),
        get: redisGet,
        config: vi.fn(async () => ["maxmemory-policy", "noeviction"]),
      })),
    });
    const deps = await buildProductionDepsFromEnv(fullEnv(), factories);

    await expect(deps.readiness?.()).resolves.toBe(true);
    expect(query).toHaveBeenCalledWith("SELECT 1");
    expect(redisGet).toHaveBeenCalledWith("__gate_readiness__");

    redisGet.mockRejectedValueOnce(new Error("redis unavailable"));
    await expect(deps.readiness?.()).resolves.toBe(false);
  });

  it("builds per-installation GitHub clients and an HMAC-configured engine client", async () => {
    const engineClient = vi.fn(
      (): JudgmentEngineClient => ({
        review: vi.fn(async () => ({ status: "not_reviewed", reason: "preview_unavailable", detail: "test" })),
        cancel: vi.fn(async () => undefined),
      }),
    );
    const githubPullsClient = vi.fn(baseFactories().githubPullsClient);
    const repoConfigClient = vi.fn(baseFactories().repoConfigClient);
    const appReviewClient = vi.fn(baseFactories().appReviewClient);
    const deps = await buildProductionDepsFromEnv(
      fullEnv(),
      baseFactories({ engineClient, githubPullsClient, repoConfigClient, appReviewClient }),
    );

    await expect(deps.resolvePullRequest("acme", "web", "sha", 77)).resolves.toEqual({
      number: 42,
      headSha: "sha",
      baseSha: "base",
    });
    const clients = await deps.installationClients({
      installationId: "77",
      owner: "acme",
      name: "web",
      prNumber: 42,
      headSha: "sha",
      baseSha: "base",
      previewUrl: "https://acme.vercel.app",
      previewProvider: "vercel",
      previewSource: "deployment_status",
      depth: "deep",
    });
    const config = await deps.loadConfig?.({
      installationId: "77",
      owner: "acme",
      name: "web",
      prNumber: 42,
      headSha: "sha",
      baseSha: "base",
      previewUrl: "https://acme.vercel.app",
      previewProvider: "vercel",
      previewSource: "deployment_status",
      depth: "deep",
    });

    expect(githubPullsClient).toHaveBeenCalledWith("token-77");
    expect(repoConfigClient).toHaveBeenCalledWith("token-77");
    expect(config?.brand).toBe("loaded by token-77");
    expect(appReviewClient).toHaveBeenCalledWith("token-77", {
      owner: "acme",
      name: "web",
      prNumber: 42,
      headSha: "sha",
    });
    expect(engineClient).toHaveBeenCalledWith({
      hostedEndpoint: "https://engine.example",
      apiKey: "engine-key",
      hmacSecret: "hmac-secret",
    });
    expect(clients.comments).toBeDefined();
    expect(clients.engine).toBeDefined();
  });

  it("wires production screenshot and feedback routes to SQL-backed stores", async () => {
    const consumed = new Set<string>();
    const seenSql: string[] = [];
    const tenantIds: string[] = [];
    const query: QueryFn = vi.fn(async (sql, params) => {
      seenSql.push(sql);
      if (sql.includes("feedback_consumed_tokens")) {
        const jti = String(params?.[0]);
        if (consumed.has(jti)) return { rows: [] };
        consumed.add(jti);
        return { rows: [{ jti }] };
      }
      return { rows: [] };
    });
    const tenant: TenantTxRunner = {
      withTenant: vi.fn(async (installationId, fn) => {
        tenantIds.push(String(installationId));
        return fn(query);
      }),
    };

    const deps = await buildProductionDepsFromEnv(fullEnv(), baseFactories({ sql: () => ({ query, tenant }) }));

    expect(deps.screenshotRegistry).toBeDefined();
    expect(deps.screenshotRoute).toBeDefined();
    await expect(deps.screenshotRoute?.signer.sign("jobs/1/shot.png")).resolves.toBe(
      "https://objects.example/jobs%2F1%2Fshot.png?signed=1",
    );
    expect(deps.screenshotRoute?.capabilitySecret).toBe("cap-secret");

    expect(deps.feedback).toBeDefined();
    expect(deps.feedbackRoutes).toBeDefined();
    expect(await deps.feedbackRoutes?.consumed?.consume("jti-1")).toBe(true);
    expect(await deps.feedbackRoutes?.consumed?.consume("jti-1")).toBe(false);

    await deps.feedbackRoutes?.sink.record(
      buildFeedbackEvent(
        "reaction",
        {
          installationId: "77",
          owner: "acme",
          name: "web",
          prNumber: 42,
          headSha: "sha",
          findingId: "f_001",
          source: "reaction",
        },
        1_000,
      ),
    );

    expect(tenantIds).toEqual(["77"]);
    expect(seenSql.some((sql) => sql.includes("feedback_events"))).toBe(true);
  });

  it("fails clearly when production screenshot route env is missing", async () => {
    const env = fullEnv();
    delete env.GATE_SCREENSHOT_OBJECT_URL_TEMPLATE;
    await expect(buildProductionDepsFromEnv(env, baseFactories())).rejects.toThrow(/GATE_SCREENSHOT_OBJECT_URL_TEMPLATE/);
  });
});

describe("installProductionSignalHandlers", () => {
  it("drains once on SIGTERM/SIGINT and records a clean exit", async () => {
    class TestSignalSource extends EventEmitter {
      exitCode: number | undefined;
    }
    const signalSource = new TestSignalSource();
    const stop = vi.fn(async () => undefined);
    installProductionSignalHandlers({ stop }, signalSource);

    signalSource.emit("SIGTERM");
    signalSource.emit("SIGINT");

    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(signalSource.exitCode).toBe(0));
  });

  it("records a failed exit when draining rejects", async () => {
    class TestSignalSource extends EventEmitter {
      exitCode: number | undefined;
    }
    const signalSource = new TestSignalSource();
    const onError = vi.fn();
    installProductionSignalHandlers(
      { stop: vi.fn(async () => Promise.reject(new Error("close failed"))) },
      signalSource,
      onError,
    );

    signalSource.emit("SIGINT");

    await vi.waitFor(() => expect(signalSource.exitCode).toBe(1));
    expect(onError).toHaveBeenCalledOnce();
  });
});
