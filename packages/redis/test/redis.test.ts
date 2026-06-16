import { describe, expect, it } from "vitest";
import {
  assertNoEviction,
  buildConnectionOptions,
  BULL_PREFIX,
  ENGINE_CIRCUIT_BREAKER_KEY,
  getMaxmemoryPolicy,
  REDIS_NAMESPACES,
  supersessionKey,
  tokenBucketKey,
  type RedisConfigClient,
} from "../src/index.js";

describe("key namespaces", () => {
  it("builds supersession keys under sha:", () => {
    expect(supersessionKey("acme", "web", 42)).toBe("sha:acme/web#42");
  });

  it("builds token-bucket keys under tb:", () => {
    expect(tokenBucketKey("inst_1")).toBe("tb:inst_1");
  });

  it("exposes the circuit-breaker key and BullMQ prefix", () => {
    expect(ENGINE_CIRCUIT_BREAKER_KEY).toBe("cb:engine");
    expect(BULL_PREFIX).toBe("bull");
    expect(REDIS_NAMESPACES.queue).toBe("bull:");
  });
});

describe("buildConnectionOptions", () => {
  it("is BullMQ-compatible and never silently drops commands", () => {
    const opts = buildConnectionOptions();
    expect(opts.maxRetriesPerRequest).toBeNull();
    expect(typeof opts.retryStrategy).toBe("function");
    const retry = opts.retryStrategy as (times: number) => number;
    // Always returns a delay (keeps reconnecting), capped at 5s.
    expect(retry(1)).toBe(200);
    expect(retry(100)).toBe(5000);
  });

  it("allows overrides", () => {
    const opts = buildConnectionOptions({ enableReadyCheck: false });
    expect(opts.enableReadyCheck).toBe(false);
    expect(opts.maxRetriesPerRequest).toBeNull();
  });
});

describe("assertNoEviction", () => {
  const clientWithPolicy = (policy: string): RedisConfigClient => ({
    config: async () => ["maxmemory-policy", policy],
  });

  it("reads the configured policy", async () => {
    expect(await getMaxmemoryPolicy(clientWithPolicy("noeviction"))).toBe("noeviction");
  });

  it("passes when noeviction", async () => {
    await expect(assertNoEviction(clientWithPolicy("noeviction"))).resolves.toBeUndefined();
  });

  it("throws on an evicting policy (protects the sha: guard)", async () => {
    await expect(assertNoEviction(clientWithPolicy("allkeys-lru"))).rejects.toThrow(/noeviction/);
  });
});
