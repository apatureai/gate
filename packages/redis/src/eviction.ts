/**
 * Eviction-policy guard (TRD §15.3).
 *
 * Redis must run `noeviction` so the `sha:` supersession keys and durable `bull:`
 * queue keys are never dropped under memory pressure. If they were evicted, the
 * publish-time SHA guard could read nil and let a stale review publish. TTL
 * token-bucket keys (`tb:`) expire on their own and coexist safely.
 */
export const REQUIRED_MAXMEMORY_POLICY = "noeviction";

/** Minimal client surface needed to read the policy (decoupled from ioredis). */
export interface RedisConfigClient {
  config(command: "GET", parameter: string): Promise<string[]>;
}

/** Read the server's `maxmemory-policy`. */
export async function getMaxmemoryPolicy(client: RedisConfigClient): Promise<string> {
  const result = await client.config("GET", "maxmemory-policy");
  // CONFIG GET returns a flat [name, value] pair.
  return result[1] ?? "";
}

/** Throw unless the server is configured for `noeviction`. Call on startup. */
export async function assertNoEviction(client: RedisConfigClient): Promise<void> {
  const policy = await getMaxmemoryPolicy(client);
  if (policy !== REQUIRED_MAXMEMORY_POLICY) {
    throw new Error(
      `Redis maxmemory-policy is "${policy}", expected "${REQUIRED_MAXMEMORY_POLICY}": ` +
        "the sha: supersession key must never be evicted (TRD §15.3).",
    );
  }
}
