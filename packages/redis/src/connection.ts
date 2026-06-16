import { Redis, type RedisOptions } from "ioredis";

/**
 * Resilient connection options shared by every Gate Redis client.
 *
 * - `maxRetriesPerRequest: null` — required by BullMQ for blocking commands and
 *   keeps commands queued across reconnects instead of failing fast.
 * - `retryStrategy` always returns a (capped) delay, so the client keeps
 *   reconnecting rather than silently giving up (acceptance: no silent drops).
 * - `reconnectOnError` recovers from failovers that briefly return READONLY.
 */
export function buildConnectionOptions(overrides: Partial<RedisOptions> = {}): RedisOptions {
  return {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    retryStrategy: (times: number) => Math.min(times * 200, 5000),
    reconnectOnError: (err: Error) => err.message.includes("READONLY"),
    ...overrides,
  };
}

/** Create a resilient Redis connection from a URL (e.g. `process.env.REDIS_URL`). */
export function createRedisConnection(url: string, overrides?: Partial<RedisOptions>): Redis {
  return new Redis(url, buildConnectionOptions(overrides));
}
