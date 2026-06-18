import { describe, expect, it } from "vitest";
import { isRateLimited, rateLimitDelayMs, withRateLimitRetry } from "../src/index.js";

function res(status: number, headers: Record<string, string> = {}): Response {
  return new Response("", { status, headers });
}

describe("isRateLimited", () => {
  it("detects 429 and 403 rate-limit signals only", () => {
    expect(isRateLimited(res(429))).toBe(true);
    expect(isRateLimited(res(403, { "retry-after": "1" }))).toBe(true);
    expect(isRateLimited(res(403, { "x-ratelimit-remaining": "0" }))).toBe(true);
    expect(isRateLimited(res(403))).toBe(false); // plain auth error, not rate limit
    expect(isRateLimited(res(200))).toBe(false);
  });
});

describe("rateLimitDelayMs", () => {
  it("honors Retry-After (secondary limit)", () => {
    expect(rateLimitDelayMs(res(429, { "retry-after": "3" }), 0)).toBe(3000);
  });

  it("waits until reset on a primary-limit exhaustion", () => {
    const now = 10_000;
    const delay = rateLimitDelayMs(
      res(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "70" }),
      0,
      { now: () => now },
    );
    expect(delay).toBe(70 * 1000 - now);
  });

  it("falls back to exponential backoff + jitter", () => {
    const delay = rateLimitDelayMs(res(429), 2, { baseDelayMs: 1000, rand: () => 0.5 });
    expect(delay).toBe(1000 * 2 ** 2 + 500); // 4500
  });

  it("caps at maxDelayMs", () => {
    expect(rateLimitDelayMs(res(429, { "retry-after": "9999" }), 0, { maxDelayMs: 5000 })).toBe(5000);
  });
});

describe("withRateLimitRetry", () => {
  it("retries while rate-limited then returns the success", async () => {
    const responses = [res(429, { "retry-after": "0" }), res(429, { "retry-after": "0" }), res(200)];
    let i = 0;
    const out = await withRateLimitRetry(async () => responses[i++]!, { sleep: async () => {} });
    expect(out.status).toBe(200);
    expect(i).toBe(3);
  });

  it("gives up after maxRetries and returns the last response", async () => {
    let calls = 0;
    const out = await withRateLimitRetry(
      async () => {
        calls++;
        return res(429, { "retry-after": "0" });
      },
      { maxRetries: 2, sleep: async () => {} },
    );
    expect(out.status).toBe(429);
    expect(calls).toBe(3); // initial + 2 retries
  });
});
