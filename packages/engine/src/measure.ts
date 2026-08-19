import { injectTraceContext, SPAN_NAMES, withSpan } from "@gate/observability";
import type { GateMeasurementRequest, GateMeasurementResult } from "@gate/types";
import { createHash } from "node:crypto";
import { signEngineRequest } from "./hmac.js";
import {
  EngineJobError,
  type JobState,
  type SubmitResponse,
  parseRetryAfterMs,
  RetryableEngineError,
} from "./jobs.js";
import { GateMeasurementResultSchema, majorVersion, SCHEMA_VERSION } from "./contract.js";
import { defaultSleep } from "./sleep.js";

/**
 * The MEASURE-ONLY client: capture, measure, stop.
 *
 * WHY IT IS NOT THE REVIEW CLIENT WITH A FLAG. Recording a measurement baseline
 * for every commit that lands on a default branch is only affordable because a
 * baseline needs no model call. `JudgmentEngineClient` always spends one. Two
 * clients over two endpoints is the only arrangement in which "a push never
 * spends a model call" is a property of the wire rather than a promise about a
 * boolean, and a service that has not implemented the measure endpoint answers
 * 404 instead of quietly running a review and billing for it.
 *
 * NOTHING HERE PUBLISHES. There is no grade, no Check Run, no comment and no
 * delivery decision on this path; the result is a set of measured facts that
 * goes straight into the baseline store. That is what makes a push not a review.
 */

/** Deadline for one measure-only job. Capture without a model, so well under a review's. */
export const MEASUREMENT_DEADLINE_MS = 5 * 60 * 1000;

/**
 * Versioned namespace for the measure intent key.
 *
 * Domain-separated from `GATE_REVIEW_INTENT_NAMESPACE` on purpose: a measure of
 * a commit and a review of a pull request at that commit are different intents
 * with different costs, and a shared key would let one 409 the other.
 */
export const GATE_MEASURE_INTENT_NAMESPACE = "gate-measure-v1";

export interface MeasurementSubmission {
  /** `gate-measure-v1:sha256:<digest>` over canonical `(owner, name, commit_sha)`. */
  idempotencyKey: string;
  request: GateMeasurementRequest;
}

export interface MeasurementJobStatus {
  jobId: string;
  state: JobState;
  /** Present when state === "completed". */
  result?: GateMeasurementResult;
  /** Present when state === "failed". */
  error?: string;
}

/**
 * Transport seam over the measure endpoint. Faked in tests; the HTTP
 * implementation below signs with the same HMAC the review transport uses.
 *
 * There is no `cancel`. Nothing supersedes a baseline run: it is keyed to an
 * immutable commit, no user is waiting on it, and a DELETE would be one more
 * call a push could make for no benefit.
 */
export interface MeasurementTransport {
  submit(submission: MeasurementSubmission, signal?: AbortSignal): Promise<SubmitResponse>;
  poll(jobId: string, installationId: string, signal?: AbortSignal): Promise<MeasurementJobStatus>;
}

/** Capture-and-measure only. Implemented over HTTP below; injected in tests. */
export interface MeasurementProbe {
  measure(request: GateMeasurementRequest, signal?: AbortSignal): Promise<GateMeasurementResult>;
}

export interface MeasurementProbeOptions {
  /** Overall deadline from submit (default `MEASUREMENT_DEADLINE_MS`). */
  deadlineMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

function canonicalPart(label: string, value: string): string {
  const canonical = value.normalize("NFKC").trim().toLowerCase();
  if (canonical.length === 0 || canonical.includes("/")) {
    throw new EngineJobError(`measurement identity has invalid ${label}`);
  }
  return canonical;
}

/**
 * Gate's opaque intent key for measuring one commit of one repository.
 *
 * The commit is the whole identity. Two pushes that land the same commit on the
 * same branch (a revert-and-reland, a webhook redelivery) are the same intent,
 * and the engine's own idempotency then makes the second one free.
 */
export function measurementIntentKey(request: GateMeasurementRequest): string {
  const commitSha = request.commitSha.trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(commitSha)) {
    throw new EngineJobError("measurement identity requires a full 40-character commit SHA");
  }
  const tuple = JSON.stringify([
    GATE_MEASURE_INTENT_NAMESPACE,
    canonicalPart("repository owner", request.repository.owner),
    canonicalPart("repository name", request.repository.name),
    commitSha,
  ]);
  const digest = createHash("sha256").update(tuple, "utf8").digest("hex");
  return `${GATE_MEASURE_INTENT_NAMESPACE}:sha256:${digest}`;
}

/** Poll delay: 10s, then +10s each attempt. Same shape as the review client's triage cadence. */
export function nextMeasurementPollDelayMs(attempt: number): number {
  return 10_000 + attempt * 10_000;
}

/**
 * Submit once, poll until the job settles, return the measured facts.
 *
 * SUBMIT IS NOT RETRIED, and that is a decision rather than an omission. A push
 * to a busy default branch can arrive many times a minute; a client that retried
 * a failing submit would turn one bad minute into a stampede against the same
 * engine that is already failing. A failed measure costs the NEXT pull request
 * its scoping and costs this push nothing, so the cheap answer is the right one.
 */
export function createMeasurementProbe(
  transport: MeasurementTransport,
  options: MeasurementProbeOptions = {},
): MeasurementProbe {
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const deadlineMs = options.deadlineMs ?? MEASUREMENT_DEADLINE_MS;

  return {
    async measure(request, signal) {
      const submission: MeasurementSubmission = {
        idempotencyKey: measurementIntentKey(request),
        request,
      };
      const { jobId } = await transport.submit(submission, signal);
      const expireAt = now() + deadlineMs;
      for (let attempt = 0; ; attempt++) {
        const status = await transport.poll(jobId, request.installationId, signal);
        if (status.state === "completed") {
          if (!status.result) {
            throw new EngineJobError("measure job completed with no measurement result");
          }
          return status.result;
        }
        if (status.state === "failed") {
          throw new EngineJobError(`measure job failed: ${status.error ?? "unknown error"}`);
        }
        const delay = nextMeasurementPollDelayMs(attempt);
        if (now() + delay > expireAt) {
          throw new EngineJobError(`measure job ${jobId} did not finish within ${deadlineMs}ms`);
        }
        await sleep(delay);
      }
    },
  };
}

export interface HttpMeasurementTransportOptions {
  baseUrl: string;
  apiKey?: string;
  /** Same `engineHmacSecret` the review transport signs with. */
  hmacSecret?: string;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

async function parseJsonBody(res: Response): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await res.json();
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function measureFailure(op: string, res: Response): Promise<EngineJobError> {
  const body = await parseJsonBody(res);
  const code = typeof body["error"] === "string" && body["error"].length > 0 ? body["error"] : null;
  return new EngineJobError(`measure ${op} failed: ${res.status}${code ? ` (${code})` : ""}`, {
    code,
    status: res.status,
  });
}

/**
 * HTTP transport for the measure endpoint: `POST /measurements` -> 202 {jobId}
 * (409 on a duplicate key -> poll the existing job), `GET /measurements/:id`.
 *
 * Deliberately a DIFFERENT PATH from `/jobs`. A service that has not implemented
 * measure-only answers 404 here, which records no baseline and spends nothing.
 * Had this been a field on the review request, that same service would have
 * stripped the field, run a full review and billed a model call for every push.
 */
export function createHttpMeasurementTransport(
  options: HttpMeasurementTransportOptions,
): MeasurementTransport {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = options.baseUrl.replace(/\/$/, "");
  const timeout = options.requestTimeoutMs ?? 30_000;

  const headers = (bodyForSignature: string, installationId: string): Record<string, string> => {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (options.apiKey) h["authorization"] = `Bearer ${options.apiKey}`;
    if (options.hmacSecret) {
      Object.assign(
        h,
        signEngineRequest({ body: bodyForSignature, installationId, secret: options.hmacSecret }),
      );
    }
    injectTraceContext(h);
    return h;
  };

  const withTimeout = async (
    fn: (signal: AbortSignal) => Promise<Response>,
    external?: AbortSignal,
  ): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const signal = external ? AbortSignal.any([controller.signal, external]) : controller.signal;
    try {
      return await fn(signal);
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    async submit(submission, abortSignal) {
      return withSpan(SPAN_NAMES.engineCall, async (span) => {
        span.setAttribute("engine.op", "measure_submit");
        const body = JSON.stringify(submission);
        const res = await withTimeout(
          (signal) =>
            fetchImpl(`${base}/measurements`, {
              method: "POST",
              headers: headers(body, submission.request.installationId),
              body,
              signal,
            }),
          abortSignal,
        );
        if (res.status === 202 || res.status === 409) {
          const responseBody = (await parseJsonBody(res)) as { jobId?: unknown };
          if (typeof responseBody.jobId !== "string" || responseBody.jobId.length === 0) {
            throw await measureFailure("submit", res);
          }
          return { status: res.status, jobId: responseBody.jobId };
        }
        if (res.status === 429 || res.status === 503) {
          throw new RetryableEngineError(
            `measure submit transient ${res.status}`,
            parseRetryAfterMs(res.headers.get("retry-after")),
          );
        }
        throw await measureFailure("submit", res);
      });
    },

    async poll(jobId, installationId, abortSignal) {
      return withSpan(SPAN_NAMES.engineCall, async (span) => {
        span.setAttribute("engine.op", "measure_poll");
        const res = await withTimeout(
          (signal) =>
            fetchImpl(`${base}/measurements/${encodeURIComponent(jobId)}`, {
              headers: headers("", installationId),
              signal,
            }),
          abortSignal,
        );
        if (!res.ok) throw await measureFailure("poll", res);
        const status = (await res.json()) as MeasurementJobStatus;
        if (status.state === "completed") {
          const parsed = parseMeasurementResult(status.result, res.headers.get("x-schema-version"));
          if (!parsed.ok) {
            throw new EngineJobError(`measure result contract violation: ${parsed.reason}`, {
              code: parsed.reason,
            });
          }
          return { ...status, result: parsed.result };
        }
        return status;
      });
    },
  };
}

export type ParseMeasurementResult =
  | { ok: true; result: GateMeasurementResult }
  | { ok: false; reason: string };

/**
 * Validate a measure-only payload before it can become a baseline.
 *
 * Two checks, and the second is the one that matters here. The first is the
 * usual major-version + shape parse the review contract already does. The second
 * REFUSES a payload that carries `grade`, `findings`, `overall` or `provenance`:
 * those fields only exist on a judged result, so their presence means the
 * service ran a model on a request that asked it not to. Stripping them, which
 * is what a permissive parse would do, would leave Gate holding a baseline it
 * paid a model call for while its logs said no model call was made. Gate refuses
 * the payload instead, records nothing, and names the field it saw.
 */
export function parseMeasurementResult(
  payload: unknown,
  schemaVersionHeader: string | null,
): ParseMeasurementResult {
  const major = majorVersion(schemaVersionHeader);
  if (major === null) {
    return { ok: false, reason: "schema_version_mismatch: missing x-schema-version header" };
  }
  if (major !== SCHEMA_VERSION) {
    return {
      ok: false,
      reason: `schema_version_mismatch: unsupported schema version ${schemaVersionHeader} (Gate supports major ${SCHEMA_VERSION})`,
    };
  }
  if (payload === null || typeof payload !== "object") {
    return { ok: false, reason: "measurement_result_not_an_object" };
  }
  for (const judged of ["grade", "findings", "overall", "provenance"] as const) {
    if (judged in (payload as Record<string, unknown>)) {
      return { ok: false, reason: `judged_field_on_measure_result: ${judged}` };
    }
  }
  const parsed = GateMeasurementResultSchema.safeParse(payload);
  if (!parsed.success) {
    return { ok: false, reason: `measurement_result_invalid: ${parsed.error.issues[0]?.message ?? "unknown"}` };
  }
  return { ok: true, result: parsed.data };
}
