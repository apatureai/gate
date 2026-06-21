import { describe, expect, it } from "vitest";
import { waitForReadiness } from "../src/readiness.js";

/** Virtual clock: sleep advances now so the ceiling is deterministic. */
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

describe("waitForReadiness — Part 1 extensions (#70)", () => {
  it("defaults to strict 200 (App-path behavior unchanged): 401 is NOT ready", async () => {
    const result = await waitForReadiness({
      url: "http://127.0.0.1:3000",
      fetchImpl: statusFetch([401]),
      ceilingMs: 10_000,
      ...clock(),
    });
    expect(result).toEqual({ ready: false, reason: "ceiling_exceeded" });
  });

  it("accepts a custom predicate (Playwright set: 401/302 ready, 503/404 not)", async () => {
    const accept = (s: number) => (s >= 200 && s < 404) || s === 401 || s === 402 || s === 403;
    expect((await waitForReadiness({ url: "u", fetchImpl: statusFetch([401]), acceptStatus: accept, ...clock() })).ready).toBe(true);
    expect((await waitForReadiness({ url: "u", fetchImpl: statusFetch([302]), acceptStatus: accept, ...clock() })).ready).toBe(true);
    expect(
      (await waitForReadiness({ url: "u", fetchImpl: statusFetch([503]), acceptStatus: accept, ceilingMs: 5_000, ...clock() })).ready,
    ).toBe(false);
  });

  it("short-circuits with child_exited the moment the spawned process dies", async () => {
    let alive = true;
    let probes = 0;
    const fetchImpl = (async () => {
      probes += 1;
      if (probes >= 2) alive = false; // the dev server crashes after the 2nd probe
      return new Response("", { status: 503 });
    }) as unknown as typeof fetch;
    const result = await waitForReadiness({
      url: "http://127.0.0.1:3000",
      fetchImpl,
      abortOnChildExit: () => !alive,
      ceilingMs: 1_000_000, // would otherwise poll forever
      ...clock(),
    });
    expect(result).toEqual({ ready: false, reason: "child_exited" });
  });

  it("reports child_exited immediately if the child is already dead", async () => {
    const result = await waitForReadiness({
      url: "u",
      fetchImpl: statusFetch([200]),
      abortOnChildExit: () => true,
      ...clock(),
    });
    expect(result).toEqual({ ready: false, reason: "child_exited" });
  });
});
