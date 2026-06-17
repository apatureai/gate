/**
 * Readiness-driven debounce (TRD §3.2, §15.2). Replaces a fixed 90s timer: poll
 * the preview for HTTP 200 up to a 120s ceiling, honoring `wait_seconds` as an
 * override floor, then hand off to the engine's in-page stability protocol (the
 * real arbiter of "settled"). The pattern is abort-and-restart on the latest
 * push — start immediately, abort on supersession (signal), restart for the new
 * SHA — NOT a delay-start timer that would slow the push→deploy→review loop.
 */
export const READINESS_CEILING_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;

export type ReadinessResult =
  | { ready: true; elapsedMs: number }
  | { ready: false; reason: "ceiling_exceeded" | "aborted" };

export interface ReadinessOptions {
  url: string;
  /** Override floor: wait at least this long before declaring ready. */
  waitSeconds?: number;
  /** Max time to keep polling (default 120s). */
  ceilingMs?: number;
  pollIntervalMs?: number;
  /** Supersession signal; abort-and-restart on a newer push. */
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function probe(url: string, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<boolean> {
  try {
    const res = await fetchImpl(url, { method: "GET", signal });
    return res.status === 200;
  } catch {
    return false; // not reachable yet
  }
}

export async function waitForReadiness(options: ReadinessOptions): Promise<ReadinessResult> {
  const ceiling = options.ceilingMs ?? READINESS_CEILING_MS;
  const interval = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const fetchImpl = options.fetchImpl ?? fetch;
  const start = now();

  const aborted = (): boolean => options.signal?.aborted ?? false;
  if (aborted()) return { ready: false, reason: "aborted" };

  // Override floor (wait_seconds): never declare ready before this.
  const floorMs = (options.waitSeconds ?? 0) * 1000;
  if (floorMs > 0) {
    await sleep(floorMs);
    if (aborted()) return { ready: false, reason: "aborted" };
  }

  for (;;) {
    if (aborted()) return { ready: false, reason: "aborted" };
    if (await probe(options.url, fetchImpl, options.signal)) {
      return { ready: true, elapsedMs: now() - start };
    }
    if (now() - start >= ceiling) return { ready: false, reason: "ceiling_exceeded" };
    await sleep(interval);
  }
}
