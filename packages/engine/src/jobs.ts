import type { GateReviewRequest, GateReviewResult, ReviewDepth } from "@gate/types";

/**
 * Async job protocol for the Gate -> judgment-engine seam (TRD §6, §15.1).
 *
 * A review takes 90s+; Gate must not hold a connection open (the Fly proxy idle
 * timeout would drop it). Gate submits a job and polls. The engine-side handlers
 * live in apatureai/judgment-engine; this module is the Gate-side contract +
 * client. HMAC signing (#47) and x-schema-version + Zod parse (#46) layer on the
 * transport later.
 */

/** The §5 full-review deadline: at most one full review per PR per 10 minutes. */
export const REVIEW_DEADLINE_MS = 10 * 60 * 1000;

export type JobState = "pending" | "running" | "completed" | "failed";

export interface JobStatus {
  jobId: string;
  state: JobState;
  /** Present when state === "completed". */
  result?: GateReviewResult;
  /** Present when state === "failed". */
  error?: string;
}

export interface JobSubmission {
  /** `${prNumber}:${headSha}` — dedupes capture across retries/pushes. */
  idempotencyKey: string;
  depth: ReviewDepth;
  request: GateReviewRequest;
}

export interface SubmitResponse {
  /** 202 (created) or 409 (duplicate idempotency key -> poll existing). */
  status: 202 | 409;
  jobId: string;
}

/**
 * Transport seam over the engine HTTP API. Faked in tests; the real impl uses
 * fetch and (via #47) HMAC-signs the body. Implementations should map non-2xx/
 * non-409 responses to a thrown EngineJobError.
 */
export interface EngineTransport {
  submit(submission: JobSubmission): Promise<SubmitResponse>;
  poll(jobId: string): Promise<JobStatus>;
  cancel(jobId: string): Promise<void>;
}

export class EngineJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineJobError";
  }
}

/** Thrown when a review is superseded (AbortSignal fired) during polling (#4). */
export class EngineAbortedError extends EngineJobError {
  readonly jobId: string;
  constructor(jobId: string) {
    super(`engine job ${jobId} aborted (superseded)`);
    this.name = "EngineAbortedError";
    this.jobId = jobId;
  }
}

/** A transient engine error (429/503) carrying an optional Retry-After delay. */
export class RetryableEngineError extends EngineJobError {
  readonly retryAfterMs: number | null;
  constructor(message: string, retryAfterMs: number | null) {
    super(message);
    this.name = "RetryableEngineError";
    this.retryAfterMs = retryAfterMs;
  }
}

/** Parse an HTTP `Retry-After` header (delta-seconds or HTTP-date) to ms. */
export function parseRetryAfterMs(header: string | null, now: number = Date.now()): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - now);
  return null;
}

/** Build the idempotency key for a PR review. */
export function idempotencyKey(prNumber: number, headSha: string): string {
  return `${prNumber}:${headSha}`;
}

/**
 * Depth-aware poll delay (TRD §15.1): triage first poll ~10s, deep ~30s, then
 * +10s each subsequent attempt. `attempt` is 0-based.
 */
export function nextPollDelayMs(depth: ReviewDepth, attempt: number): number {
  const base = depth === "deep" ? 30_000 : 10_000;
  return base + attempt * 10_000;
}

export type PollOutcome =
  | { status: "completed"; result: GateReviewResult; jobId: string }
  | { status: "failed"; error: string; jobId: string }
  /** Deadline hit; delivery posts a neutral Check Run, reason review_timed_out, no retry. */
  | { status: "timed_out"; reason: "review_timed_out"; jobId: string };

export interface PollOptions {
  depth: ReviewDepth;
  /** Overall deadline from submit (default = §5 10-minute cap). */
  deadlineMs?: number;
  /** Supersession signal; when aborted, polling stops with EngineAbortedError (#4). */
  signal?: AbortSignal;
  /** Injectable clock + sleep for deterministic tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll a job with depth-aware backoff until it completes, fails, or the deadline
 * passes. On deadline, returns `timed_out` with no further retries.
 */
export async function pollUntilDone(
  transport: EngineTransport,
  jobId: string,
  options: PollOptions,
): Promise<PollOutcome> {
  const deadlineMs = options.deadlineMs ?? REVIEW_DEADLINE_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const start = now();

  for (let attempt = 0; ; attempt++) {
    // Stage-boundary supersession check (#4): stop before doing more work.
    if (options.signal?.aborted) throw new EngineAbortedError(jobId);
    const status = await transport.poll(jobId);
    if (status.state === "completed") {
      if (!status.result) throw new EngineJobError(`job ${jobId} completed without a result`);
      return { status: "completed", result: status.result, jobId };
    }
    if (status.state === "failed") {
      return { status: "failed", error: status.error ?? "engine job failed", jobId };
    }

    const elapsed = now() - start;
    const remaining = deadlineMs - elapsed;
    if (remaining <= 0) {
      return { status: "timed_out", reason: "review_timed_out", jobId };
    }
    const delay = Math.min(nextPollDelayMs(options.depth, attempt), remaining);
    await sleep(delay);
    if (options.signal?.aborted) throw new EngineAbortedError(jobId);
    if (now() - start >= deadlineMs) {
      return { status: "timed_out", reason: "review_timed_out", jobId };
    }
  }
}

/**
 * Submit a review job and await its outcome. A 409 (duplicate idempotency key)
 * polls the existing job rather than re-running capture.
 */
export async function runEngineJob(
  transport: EngineTransport,
  submission: JobSubmission,
  options: PollOptions,
): Promise<PollOutcome> {
  const response = await transport.submit(submission);
  // Both 202 and 409 yield a jobId to poll; 409 means capture is already running.
  return pollUntilDone(transport, response.jobId, options);
}

/** Best-effort cancellation on supersession; never throws. */
export async function cancelEngineJob(transport: EngineTransport, jobId: string): Promise<void> {
  try {
    await transport.cancel(jobId);
  } catch {
    // Cancellation is best-effort; the publish-time SHA guard is the backstop.
  }
}
