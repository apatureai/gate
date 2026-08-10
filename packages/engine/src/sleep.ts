/**
 * The engine package's default sleep.
 *
 * `defaultSleep` was copy-pasted, byte-identical, into client.ts, jobs.ts,
 * readiness.ts, and rate-limit.ts, each the injectable default behind an
 * `options.sleep ?? defaultSleep` retry/backoff seam. It is the one real-timer
 * fallback the retrying loops share (tests inject a fake), so it lives in one
 * place.
 */

/** Resolve after `ms` milliseconds. The production default behind an injectable `sleep`. */
export const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
