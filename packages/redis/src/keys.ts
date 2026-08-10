/**
 * Redis key namespaces for the orchestrator hot paths (TRD §5, §12).
 *
 * - `bull:` is the BullMQ review queue (durable; do not evict).
 * - `sha:`  is the `current_sha[repo#pr]` supersession store (MUST NOT be evicted;
 *           eviction would let the publish-time guard read nil and pass a
 *           stale SHA, §15.3).
 * - `tb:`   is the per-installation token-bucket for fair scheduling (TTL keys).
 * - `cb:`   is circuit-breaker state, e.g. `cb:engine` (§15.3).
 */
export const REDIS_NAMESPACES = {
  queue: "bull:",
  sha: "sha:",
  tokenBucket: "tb:",
  circuitBreaker: "cb:",
} as const;

/** BullMQ `prefix` so its keys land under the `bull:` namespace. */
export const BULL_PREFIX = "bull";

/** `current_sha` supersession key for a PR: `sha:<owner>/<name>#<pr>`. */
export function supersessionKey(owner: string, name: string, prNumber: number): string {
  return `${REDIS_NAMESPACES.sha}${owner}/${name}#${prNumber}`;
}

/** Per-installation token-bucket key: `tb:<installationId>`. */
export function tokenBucketKey(installationId: string): string {
  return `${REDIS_NAMESPACES.tokenBucket}${installationId}`;
}

/** Circuit-breaker state key for the judgment-engine client. */
export const ENGINE_CIRCUIT_BREAKER_KEY = `${REDIS_NAMESPACES.circuitBreaker}engine`;
