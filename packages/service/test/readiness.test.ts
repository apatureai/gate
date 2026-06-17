import { describe, expect, it } from "vitest";
import { READINESS_CEILING_MS, waitForReadiness } from "../src/readiness.js";

/** Virtual clock: sleep advances now so backoff/ceiling are deterministic. */
function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

function statusFetch(statuses: number[]): typeof fetch {
  let i = 0;
  return (async () => {
    const status = statuses[Math.min(i, statuses.length - 1)] ?? 200;
    i += 1;
    return new Response("", { status });
  }) as unknown as typeof fetch;
}

describe("waitForReadiness", () => {
  it("returns ready when the preview responds 200 (after a few non-200s)", async () => {
    const result = await waitForReadiness({
      url: "https://preview.example.com",
      fetchImpl: statusFetch([503, 404, 200]),
      ...clock(),
    });
    expect(result).toEqual({ ready: true, elapsedMs: expect.any(Number) });
  });

  it("gives up at the 120s ceiling, no fixed 90s timer", async () => {
    const result = await waitForReadiness({
      url: "https://preview.example.com",
      fetchImpl: statusFetch([503]),
      ...clock(),
    });
    expect(result).toEqual({ ready: false, reason: "ceiling_exceeded" });
    expect(READINESS_CEILING_MS).toBe(120_000);
  });

  it("honors wait_seconds as an override floor before declaring ready", async () => {
    const result = await waitForReadiness({
      url: "https://preview.example.com",
      waitSeconds: 10,
      fetchImpl: statusFetch([200]), // ready immediately, but floor must elapse
      ...clock(),
    });
    expect(result.ready).toBe(true);
    if (result.ready) expect(result.elapsedMs).toBeGreaterThanOrEqual(10_000);
  });

  it("aborts on supersession (pre-aborted and mid-poll)", async () => {
    const pre = new AbortController();
    pre.abort();
    expect(await waitForReadiness({ url: "https://x", signal: pre.signal, fetchImpl: statusFetch([200]), ...clock() })).toEqual({
      ready: false,
      reason: "aborted",
    });

    const mid = new AbortController();
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) mid.abort(); // newer push during the first probe
      return new Response("", { status: 503 });
    }) as unknown as typeof fetch;
    const result = await waitForReadiness({ url: "https://x", signal: mid.signal, fetchImpl, ...clock() });
    expect(result).toEqual({ ready: false, reason: "aborted" });
  });
});
