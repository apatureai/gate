/**
 * The engine's default sleep, extracted from the byte-identical copies in
 * client/jobs/readiness/rate-limit (each the injectable default behind an
 * `options.sleep ?? defaultSleep` retry seam). Pins that it resolves after the
 * requested delay using real timers.
 */
import { describe, expect, it, vi } from "vitest";
import { defaultSleep } from "../src/index.js";

describe("defaultSleep", () => {
  it("resolves after the given delay (fake timers)", async () => {
    vi.useFakeTimers();
    try {
      let done = false;
      const p = defaultSleep(500).then(() => {
        done = true;
      });
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(500);
      await p;
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns a promise", () => {
    vi.useFakeTimers();
    const p = defaultSleep(0);
    expect(p).toBeInstanceOf(Promise);
    vi.runAllTimers();
    vi.useRealTimers();
  });
});
