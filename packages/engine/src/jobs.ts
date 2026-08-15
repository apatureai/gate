import type { GateReviewRequest, GateReviewResult, ReviewDepth } from "@gate/types";
import { createHash } from "node:crypto";
import { defaultSleep } from "./sleep.js";

/**
 * Async job protocol for the Gate -> verdict seam (TRD §6, §15.1).
 *
 * A review takes 90s+; Gate must not hold a connection open (the Fly proxy idle
 * timeout would drop it). Gate submits a job and polls. The engine-side handlers
 * live in apatureai/verdict; this module is the Gate-side contract +
 * client. HMAC signing (#47) and x-schema-version + Zod parse (#46) layer on the
 * transport later.
 */

/** The §5 full-review deadline: at most one full review per PR per 10 minutes. */
export const REVIEW_DEADLINE_MS = 10 * 60 * 1000;

/**
 * Versioned namespace for Gate's caller-owned Verdict intent hash.
 *
 * Legacy keys used the ambiguous, repository-less `${prNumber}:${headSha}`
 * shape. Keeping the namespace outside and inside the digest makes the new key
 * visibly incompatible with those persisted keys and domain-separates future
 * formats.
 */
export const GATE_REVIEW_INTENT_NAMESPACE = "gate-review-v2";

export interface ReviewIdentityInput {
  repository: { owner: string; name: string };
  pullRequest: { number: number; headSha: string };
}

/** Canonical completed-review identity carried with a client outcome. */
export interface ReviewIdentity {
  repositoryOwner: string;
  repositoryName: string;
  prNumber: number;
  headSha: string;
}

/**
 * The states `GET /jobs/:id` can report.
 *
 * `cancelling` is the transitional state the engine enters the moment a DELETE
 * is accepted, before the work has actually stopped. It was missing from this
 * union while the engine already emitted it, so the type claimed a poll could
 * only return four values and the fifth reached the "not terminal yet" branch by
 * accident rather than by decision. Continuing to poll IS the right response (a
 * cancelling job settles into `failed` with `error: "canceled"`), but that is a
 * choice, and it is written down here instead of inferred from a fall-through.
 */
export type JobState = "pending" | "running" | "cancelling" | "completed" | "failed";

export interface JobStatus {
  jobId: string;
  state: JobState;
  /** Present when state === "completed". */
  result?: GateReviewResult;
  /** Present when state === "failed". */
  error?: string;
}

export interface JobSubmission {
  /** `gate-review-v2:sha256:<digest>` over canonical `(repo, pr, head_sha)`. */
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
  submit(submission: JobSubmission, signal?: AbortSignal): Promise<SubmitResponse>;
  /** `signal` aborts the in-flight request on supersession (§15.3). */
  poll(jobId: string, installationId: string, signal?: AbortSignal): Promise<JobStatus>;
  cancel(jobId: string, installationId: string): Promise<void>;
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

function canonicalRepositoryPart(label: string, value: string): string {
  const canonical = value.normalize("NFKC").trim().toLowerCase();
  const hasControlCharacter = [...canonical].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
  if (canonical.length === 0 || canonical.includes("/") || hasControlCharacter) {
    throw new EngineJobError(`review identity has invalid ${label}`);
  }
  return canonical;
}

/**
 * Canonicalize the repository-scoped completed-review identity. GitHub owner
 * and repository names are case-insensitive; full commit SHAs are hexadecimal.
 */
export function canonicalReviewIdentity(input: ReviewIdentityInput): ReviewIdentity {
  const prNumber = input.pullRequest.number;
  if (!Number.isSafeInteger(prNumber) || prNumber < 1) {
    throw new EngineJobError("review identity has invalid pull request number");
  }
  const headSha = input.pullRequest.headSha.trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(headSha)) {
    throw new EngineJobError("review identity requires a full 40-character head SHA");
  }
  return {
    repositoryOwner: canonicalRepositoryPart("repository owner", input.repository.owner),
    repositoryName: canonicalRepositoryPart("repository name", input.repository.name),
    prNumber,
    headSha,
  };
}

/**
 * Build Gate's opaque Verdict intent key from an unambiguous canonical
 * tuple. JSON array encoding preserves field boundaries before hashing.
 */
export function idempotencyKey(input: ReviewIdentityInput): string {
  const identity = canonicalReviewIdentity(input);
  const tuple = JSON.stringify([
    GATE_REVIEW_INTENT_NAMESPACE,
    identity.repositoryOwner,
    identity.repositoryName,
    identity.prNumber,
    identity.headSha,
  ]);
  const digest = createHash("sha256").update(tuple, "utf8").digest("hex");
  return `${GATE_REVIEW_INTENT_NAMESPACE}:sha256:${digest}`;
}

export function sameReviewIdentity(actual: ReviewIdentity, expected: ReviewIdentityInput): boolean {
  const canonical = canonicalReviewIdentity(expected);
  return (
    actual.repositoryOwner === canonical.repositoryOwner &&
    actual.repositoryName === canonical.repositoryName &&
    actual.prNumber === canonical.prNumber &&
    actual.headSha === canonical.headSha
  );
}

function submitAbortId(submission: JobSubmission): string {
  return `submit:${submission.idempotencyKey}`;
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
  /** Installation that owns the engine job; used to sign poll/cancel requests (#85). */
  installationId?: string;
  /** Injectable clock + sleep for deterministic tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}


const timedOutOutcome = (jobId: string): PollOutcome => ({
  status: "timed_out",
  reason: "review_timed_out",
  jobId,
});

/**
 * Abandoning the customer-visible poll must also signal intent cancellation to
 * the engine. The DELETE is bounded by the transport request timeout. Its
 * failure is deliberately reduced to one low-cardinality diagnostic: cleanup
 * cannot turn the existing neutral timeout into an engine error or retry.
 */
async function cancelTimedOutJob(
  transport: EngineTransport,
  jobId: string,
  installationId: string,
): Promise<PollOutcome> {
  try {
    await transport.cancel(jobId, installationId);
  } catch {
    console.warn("[gate] timed-out engine job cancellation failed");
  }
  return timedOutOutcome(jobId);
}

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
  if (options.signal?.aborted) throw new EngineAbortedError(jobId);
  const installationId = options.installationId;
  if (!installationId) throw new EngineJobError(`job ${jobId} poll requires installationId`);

  for (let attempt = 0; ; attempt++) {
    // Stage-boundary supersession check (#4): stop before doing more work.
    if (options.signal?.aborted) throw new EngineAbortedError(jobId);
    let status: JobStatus;
    try {
      status = await transport.poll(jobId, installationId, options.signal);
    } catch (err) {
      // A request aborted by supersession surfaces as the typed abort error.
      if (options.signal?.aborted) throw new EngineAbortedError(jobId);
      throw err;
    }
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
      return cancelTimedOutJob(transport, jobId, installationId);
    }
    const delay = Math.min(nextPollDelayMs(options.depth, attempt), remaining);
    await sleep(delay);
    if (options.signal?.aborted) throw new EngineAbortedError(jobId);
    if (now() - start >= deadlineMs) {
      return cancelTimedOutJob(transport, jobId, installationId);
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
  if (options.signal?.aborted) throw new EngineAbortedError(submitAbortId(submission));
  let response: SubmitResponse;
  try {
    response = await transport.submit(submission, options.signal);
  } catch (err) {
    if (options.signal?.aborted) throw new EngineAbortedError(submitAbortId(submission));
    throw err;
  }
  if (options.signal?.aborted) throw new EngineAbortedError(response.jobId);
  // Both 202 and 409 yield a jobId to poll; 409 means capture is already running.
  return pollUntilDone(transport, response.jobId, {
    ...options,
    installationId: options.installationId ?? submission.request.installationId,
  });
}

/** Best-effort cancellation on supersession; never throws. */
export async function cancelEngineJob(
  transport: EngineTransport,
  jobId: string,
  installationId: string,
): Promise<void> {
  try {
    await transport.cancel(jobId, installationId);
  } catch {
    // Cancellation is best-effort; the publish-time SHA guard is the backstop.
  }
}
