import { assertNoEviction, type RedisConfigClient } from "@gate/redis";

/**
 * Boot-time invariant checks the App composition root must run before serving
 * traffic. Currently: Redis must be `noeviction` — if the `sha:` supersession
 * keys could be evicted, the publish-time guard could read nil and pass a stale
 * SHA (§15.3). Fail fast at startup rather than silently risk a stale publish.
 */
export interface StartupCheckDeps {
  redis: RedisConfigClient;
}

export async function runStartupChecks(deps: StartupCheckDeps): Promise<void> {
  await assertNoEviction(deps.redis);
}
