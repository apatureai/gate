import { parseRetryAfterMs } from "./jobs.js";
import { defaultSleep } from "./sleep.js";

/**
 * Generic GitHub rate-limit handling (TRD §15.4) — lives in the shared engine
 * layer so both the Action and App GitHub clients use it. Honors primary limits
 * (`x-ratelimit-remaining: 0` + `x-ratelimit-reset`) and secondary limits
 * (`Retry-After`) with exponential backoff + jitter.
 */
export interface RateLimitRetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  rand?: () => number;
}


/** A 429, or a 403 carrying a rate-limit signal (Retry-After or remaining 0). */
export function isRateLimited(res: Response): boolean {
  if (res.status === 429) return true;
  if (res.status === 403) {
    if (res.headers.get("retry-after")) return true;
    if (res.headers.get("x-ratelimit-remaining") === "0") return true;
  }
  return false;
}

/** How long to wait before retrying a rate-limited response. */
export function rateLimitDelayMs(res: Response, attempt: number, options: RateLimitRetryOptions = {}): number {
  const now = (options.now ?? Date.now)();
  const base = options.baseDelayMs ?? 1_000;
  const max = options.maxDelayMs ?? 60_000;
  const rand = options.rand ?? Math.random;

  const retryAfter = parseRetryAfterMs(res.headers.get("retry-after"), now);
  if (retryAfter !== null) return Math.min(retryAfter, max);

  if (res.headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    if (Number.isFinite(reset)) return Math.min(Math.max(0, reset * 1000 - now), max);
  }

  return Math.min(base * 2 ** attempt + rand() * base, max);
}

/** Send a request, retrying with backoff while GitHub rate-limits it. */
export async function withRateLimitRetry(
  send: () => Promise<Response>,
  options: RateLimitRetryOptions = {},
): Promise<Response> {
  const maxRetries = options.maxRetries ?? 5;
  const sleep = options.sleep ?? defaultSleep;
  let res = await send();
  for (let attempt = 0; attempt < maxRetries && isRateLimited(res); attempt++) {
    await sleep(rateLimitDelayMs(res, attempt, options));
    res = await send();
  }
  return res;
}
