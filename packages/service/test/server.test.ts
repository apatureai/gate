import type { CheckRun, GitHubCommentsApi } from "@gate/delivery";
import type { JudgmentEngineClient } from "@gate/engine";
import type { QueryFn, TenantTxRunner } from "@gate/db";
import { describe, expect, it, vi } from "vitest";
import type { GitHubAppAuth } from "../src/app-auth.js";
import type { AppReviewClient, AppReviewTarget } from "../src/app-github.js";
import type { GitHubPullsClient } from "../src/github-pulls.js";
import { PRODUCTION_ENV_VARS } from "../src/production-readiness.js";
import { buildProductionDepsFromEnv, type ProductionRuntimeFactories } from "../src/server.js";

function fullEnv(): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(PRODUCTION_ENV_VARS.map((name) => [name, `value-for-${name}`])),
    DATABASE_URL: "postgres://example/db",
    REDIS_URL: "redis://example",
    GITHUB_APP_ID: "12345",
    JUDGMENT_ENGINE_ENDPOINT: "https://engine.example",
    JUDGMENT_ENGINE_API_KEY: "engine-key",
    JUDGMENT_ENGINE_HMAC_SECRET: "hmac-secret",
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

  it("builds per-installation GitHub clients and an HMAC-configured engine client", async () => {
    const engineClient = vi.fn(
      (): JudgmentEngineClient => ({
        review: vi.fn(async () => ({ status: "not_reviewed", reason: "preview_unavailable", detail: "test" })),
        cancel: vi.fn(async () => undefined),
      }),
    );
    const githubPullsClient = vi.fn(baseFactories().githubPullsClient);
    const appReviewClient = vi.fn(baseFactories().appReviewClient);
    const deps = await buildProductionDepsFromEnv(fullEnv(), baseFactories({ engineClient, githubPullsClient, appReviewClient }));

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

    expect(githubPullsClient).toHaveBeenCalledWith("token-77");
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
});
