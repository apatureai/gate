import { describe, expect, it } from "vitest";
import { runStartupChecks } from "../src/startup.js";

const redisWithPolicy = (policy: string) => ({
  config: async () => ["maxmemory-policy", policy],
});

describe("runStartupChecks", () => {
  it("passes when Redis is noeviction", async () => {
    await expect(runStartupChecks({ redis: redisWithPolicy("noeviction") })).resolves.toBeUndefined();
  });

  it("fails fast when Redis could evict the sha: supersession keys", async () => {
    await expect(runStartupChecks({ redis: redisWithPolicy("allkeys-lru") })).rejects.toThrow(/noeviction/);
  });
});
