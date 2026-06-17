import type { GateReviewRequest, GateReviewResult, NormalizedDesignReviewConfig, ReviewDepth } from "@gate/types";
import {
  type EngineTransport,
  idempotencyKey,
  type JobSubmission,
  type PollOptions,
  type PollOutcome,
  pollUntilDone,
  RetryableEngineError,
  type SubmitResponse,
} from "./jobs.js";

/**
 * The single seam where Gate talks to judgment-engine (TRD §1, §6;
 * ARCHITECTURE §3). Gate owns when to call and how to publish; the engine owns
 * capture, context, model, and validation. Everything downstream programs
 * against GateReviewResult, never raw engine calls.
 */
export interface ReviewRequestContext {
  installationId: string;
  repository: { owner: string; name: string; defaultBranch: string };
  pullRequest: { number: number; headSha: string; baseSha: string; title: string; body: string | null };
  preview: { url: string; provider: GateReviewRequest["preview"]["provider"]; environment: string | null };
  config: NormalizedDesignReviewConfig;
  publishMode: GateReviewRequest["publishMode"];
  depth: ReviewDepth;
}

/** Assemble a GateReviewRequest from resolved preview + normalized config + PR context. */
export function buildGateReviewRequest(ctx: ReviewRequestContext): GateReviewRequest {
  return {
    installationId: ctx.installationId,
    repository: ctx.repository,
    pullRequest: ctx.pullRequest,
    preview: ctx.preview,
    config: ctx.config,
    publishMode: ctx.publishMode,
    depth: ctx.depth,
  };
}

/** Engine/result provenance the delivery layer records on the run (TRD §6). */
export interface ReviewMetadata {
  engineVersion: string;
  model: string;
  promptVersion: string;
  captureVersion: string;
  /** UI-DNA genome version the critique was grounded in, or null. */
  uiDnaVersion: string | null;
}

/** Surface engine/result metadata. The model is whatever the engine selected. */
export function extractReviewMetadata(result: GateReviewResult): ReviewMetadata {
  return { ...result.metadata };
}

export interface JudgmentEngineClientOptions {
  /** Bounded retries for the submit call on transient errors (default 2). */
  submitRetries?: number;
  /** Base backoff between submit retries, multiplied by attempt (default 500ms). */
  submitBackoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Default poll options (deadline/clock); per-call overrides merge over these. */
  poll?: Omit<PollOptions, "depth">;
}

export interface JudgmentEngineClient {
  review(ctx: ReviewRequestContext, pollOverrides?: Omit<PollOptions, "depth">): Promise<PollOutcome>;
  cancel(jobId: string): Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Create the judgment-engine client. Auth + request timeout live in the
 * transport; this adds bounded submit retry with backoff and is idempotent per
 * (pr, head_sha) — the idempotency key dedupes capture even across retries.
 */
export function createJudgmentEngineClient(
  transport: EngineTransport,
  options: JudgmentEngineClientOptions = {},
): JudgmentEngineClient {
  const retries = options.submitRetries ?? 2;
  const backoffMs = options.submitBackoffMs ?? 500;
  const sleep = options.sleep ?? defaultSleep;

  async function submitWithRetry(submission: JobSubmission): Promise<SubmitResponse> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await transport.submit(submission);
      } catch (err) {
        lastError = err;
        if (attempt < retries) {
          // Honor Retry-After on 429/503; otherwise linear backoff.
          const retryAfter = err instanceof RetryableEngineError ? err.retryAfterMs : null;
          await sleep(retryAfter ?? backoffMs * (attempt + 1));
        }
      }
    }
    throw lastError;
  }

  return {
    async review(ctx, pollOverrides) {
      const submission: JobSubmission = {
        idempotencyKey: idempotencyKey(ctx.pullRequest.number, ctx.pullRequest.headSha),
        depth: ctx.depth,
        request: buildGateReviewRequest(ctx),
      };
      const response = await submitWithRetry(submission);
      return pollUntilDone(transport, response.jobId, {
        depth: ctx.depth,
        ...options.poll,
        ...pollOverrides,
      });
    },

    async cancel(jobId) {
      await transport.cancel(jobId);
    },
  };
}
