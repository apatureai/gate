/**
 * Preview readiness poll (TRD §3.2, §15.2). Polls a URL until it responds within
 * a ceiling, honoring an optional `wait_seconds` floor, then hands off to the
 * engine's in-page stability protocol (the real arbiter of "settled"). The
 * pattern is abort-and-restart on the latest push: start immediately, abort on
 * supersession (signal), restart for the new SHA. NOT a delay-start timer.
 *
 * Lives in `@gate/engine` (shared) so both the App path (`@gate/service`) and the
 * Action path (`@gate/action` local-serve, #70) use one definition of "ready".
 * The ready predicate is injectable (`acceptStatus`, default strict 200 to keep
 * the App path unchanged); the Action path passes the wider Playwright set and an
 * `abortOnChildExit` source so a dead preview process short-circuits the poll.
 */

import { defaultSleep } from "./sleep.js";
export const READINESS_CEILING_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;

export type ReadinessResult =
  | { ready: true; elapsedMs: number }
  | { ready: false; reason: "ceiling_exceeded" | "aborted" | "child_exited" };

export interface ReadinessOptions {
  url: string;
  /** Override floor: wait at least this long before declaring ready. */
  waitSeconds?: number;
  /** Max time to keep polling (default 120s). */
  ceilingMs?: number;
  pollIntervalMs?: number;
  /** Supersession signal; abort-and-restart on a newer push. */
  signal?: AbortSignal;
  /** Extra request headers (e.g. Vercel protection-bypass) for the probe. */
  headers?: Record<string, string>;
  /**
   * Ready predicate over the HTTP status. Default: strict 200 (App path). The
   * Action path passes the Playwright `webServer` set {2xx,3xx,400,401,402,403}.
   */
  acceptStatus?: (status: number) => boolean;
  /**
   * Extra abort source for a spawned preview process (#70): when this returns
   * true the poll stops immediately with `child_exited` instead of waiting out
   * the ceiling on a dead port.
   */
  abortOnChildExit?: () => boolean;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultAccept = (status: number): boolean => status === 200;
const FLOOR_CHECK_INTERVAL_MS = 100;

async function probe(
  url: string,
  fetchImpl: typeof fetch,
  accept: (status: number) => boolean,
  signal?: AbortSignal,
  headers?: Record<string, string>,
): Promise<boolean> {
  try {
    const res = await fetchImpl(url, { method: "GET", signal, headers });
    return accept(res.status);
  } catch {
    return false; // not reachable yet
  }
}

async function sleepAbortably(ms: number, sleep: (ms: number) => Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await sleep(ms);
    return;
  }
  if (signal.aborted) return;

  let cleanup = (): void => undefined;
  const aborted = new Promise<void>((resolve) => {
    const onAbort = (): void => resolve();
    signal.addEventListener("abort", onAbort, { once: true });
    cleanup = () => signal.removeEventListener("abort", onAbort);
  });

  try {
    await Promise.race([sleep(ms), aborted]);
  } finally {
    cleanup();
  }
}

async function waitFloor(options: {
  floorMs: number;
  signal?: AbortSignal;
  abortOnChildExit?: () => boolean;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}): Promise<Extract<ReadinessResult, { ready: false }> | null> {
  const start = options.now();
  while (options.now() - start < options.floorMs) {
    if (options.signal?.aborted) return { ready: false, reason: "aborted" };
    if (options.abortOnChildExit?.()) return { ready: false, reason: "child_exited" };
    const remaining = options.floorMs - (options.now() - start);
    await sleepAbortably(Math.min(remaining, FLOOR_CHECK_INTERVAL_MS), options.sleep, options.signal);
  }
  if (options.signal?.aborted) return { ready: false, reason: "aborted" };
  if (options.abortOnChildExit?.()) return { ready: false, reason: "child_exited" };
  return null;
}

export async function waitForReadiness(options: ReadinessOptions): Promise<ReadinessResult> {
  const ceiling = options.ceilingMs ?? READINESS_CEILING_MS;
  const interval = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const fetchImpl = options.fetchImpl ?? fetch;
  const accept = options.acceptStatus ?? defaultAccept;
  const start = now();

  const aborted = (): boolean => options.signal?.aborted ?? false;
  if (aborted()) return { ready: false, reason: "aborted" };
  if (options.abortOnChildExit?.()) return { ready: false, reason: "child_exited" };

  // Override floor (wait_seconds): never declare ready before this.
  const floorMs = (options.waitSeconds ?? 0) * 1000;
  if (floorMs > 0) {
    const floorAbort = await waitFloor({
      floorMs,
      signal: options.signal,
      abortOnChildExit: options.abortOnChildExit,
      now,
      sleep,
    });
    if (floorAbort) return floorAbort;
  }

  for (;;) {
    if (aborted()) return { ready: false, reason: "aborted" };
    // Check the child BEFORE the probe so a crash short-circuits in one interval.
    if (options.abortOnChildExit?.()) return { ready: false, reason: "child_exited" };
    if (await probe(options.url, fetchImpl, accept, options.signal, options.headers)) {
      return { ready: true, elapsedMs: now() - start };
    }
    // A terminal child/probe condition can be discovered during the fetch
    // itself; don't sleep another interval after that point.
    if (options.abortOnChildExit?.()) return { ready: false, reason: "child_exited" };
    if (now() - start >= ceiling) return { ready: false, reason: "ceiling_exceeded" };
    await sleep(interval);
  }
}
