import { supersessionKey } from "@gate/redis";

/**
 * Three-part supersession (TRD §3.2, §7.1; §15.3) so a slow review for a stale
 * SHA can never overwrite a newer one:
 *   1. `current_sha[repo#pr]` is set on enqueue (here),
 *   2. an AbortController is signaled on a newer push and checked at stage
 *      boundaries (worker #48 + engine poll loop #4 honor the signal),
 *   3. the publish-time guard re-reads `current_sha` and discards if the job's
 *      SHA is stale (here). The comment edit also uses an optimistic node_id
 *      check (#10).
 *
 * The publish-time guard is the correctness backstop and is queue-agnostic: it
 * holds even if AbortSignal threading is bypassed.
 */
export interface SupersessionStore {
  setCurrentSha(key: string, sha: string): Promise<void>;
  getCurrentSha(key: string): Promise<string | null>;
}

/** Minimal Redis surface (satisfied by ioredis). */
export interface RedisLike {
  set(key: string, value: string): Promise<unknown>;
  get(key: string): Promise<string | null>;
}

export interface RepoPr {
  owner: string;
  name: string;
  prNumber: number;
}

/** The Redis `sha:` key for a PR. */
export function currentShaKey(repo: RepoPr): string {
  return supersessionKey(repo.owner, repo.name, repo.prNumber);
}

export function createInMemorySupersessionStore(): SupersessionStore {
  const map = new Map<string, string>();
  return {
    async setCurrentSha(key, sha) {
      map.set(key, sha);
    },
    async getCurrentSha(key) {
      return map.get(key) ?? null;
    },
  };
}

/** Redis-backed store; relies on `noeviction` so the key is never dropped (#34). */
export function createRedisSupersessionStore(redis: RedisLike): SupersessionStore {
  return {
    async setCurrentSha(key, sha) {
      await redis.set(key, sha);
    },
    async getCurrentSha(key) {
      return redis.get(key);
    },
  };
}

/** Set `current_sha[repo#pr] = headSha` on enqueue. Returns the key. */
export async function recordEnqueue(
  store: SupersessionStore,
  repo: RepoPr,
  headSha: string,
): Promise<string> {
  const key = currentShaKey(repo);
  await store.setCurrentSha(key, headSha);
  return key;
}

/** Stage-boundary check: is this job's SHA still the current one? */
export async function isCurrentSha(
  store: SupersessionStore,
  key: string,
  jobSha: string,
): Promise<boolean> {
  return (await store.getCurrentSha(key)) === jobSha;
}

/**
 * Publish-time guard: re-read `current_sha` and allow publish only if the job's
 * SHA still matches. Discards stale results regardless of AbortSignal threading.
 */
export async function guardPublish(
  store: SupersessionStore,
  key: string,
  jobSha: string,
): Promise<boolean> {
  return isCurrentSha(store, key, jobSha);
}
