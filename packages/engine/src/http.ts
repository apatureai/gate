import { injectTraceContext, SPAN_NAMES, withSpan } from "@gate/observability";
import { parseEngineResult } from "./contract.js";
import { signEngineRequest } from "./hmac.js";
import {
  EngineJobError,
  type EngineTransport,
  type JobStatus,
  type JobSubmission,
  parseRetryAfterMs,
  RetryableEngineError,
  type SubmitResponse,
} from "./jobs.js";

export interface HttpEngineTransportOptions {
  baseUrl: string;
  /** Bearer/API key for the engine. */
  apiKey?: string;
  /**
   * HMAC secret (from the KMS-backed store, `@gate/secrets` `engineHmacSecret`).
   * When set, the submit body is HMAC-SHA256 signed with installationId bound in,
   * so the engine can verify and scope storage to the verified tenant (#47).
   */
  hmacSecret?: string;
  /** Per-request timeout (ms). */
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Read a JSON body without letting a non-JSON error page throw over the real failure. */
async function parseJsonBody(res: Response): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await res.json();
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The engine's own `{"error": "..."}` code, when it sent one. */
function describeError(body: Record<string, unknown>): string | null {
  const code = body["error"];
  return typeof code === "string" && code.length > 0 ? code : null;
}

/**
 * A failure message carrying the engine's reason, not just its status.
 *
 * The engine answers every rejection with a machine-readable code
 * (`signature_mismatch`, `missing_installation`, `not_found`, ...). Swallowing it
 * left an operator with `engine submit failed: 401` and no way to tell a wrong
 * `GATE_ENGINE_HMAC_SECRET` from a missing one, which is the single most likely
 * thing to be wrong the first time someone points Gate at their own engine.
 */
async function engineFailure(op: string, res: Response): Promise<string> {
  const reason = describeError(await parseJsonBody(res));
  return `engine ${op} failed: ${res.status}${reason ? ` (${reason})` : ""}`;
}

/**
 * HTTP transport for the engine `/jobs` API. Maps 202/409 to a SubmitResponse;
 * any other non-2xx is an EngineJobError. The body Gate sends is the
 * JobSubmission (idempotencyKey + depth + GateReviewRequest); request signing
 * and x-schema-version validation are added by #47/#46.
 */
export function createHttpEngineTransport(options: HttpEngineTransportOptions): EngineTransport {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = options.baseUrl.replace(/\/$/, "");
  const timeout = options.requestTimeoutMs ?? 30_000;

  const headers = (bodyForSignature: string, installationId: string): Record<string, string> => {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (options.apiKey) h["authorization"] = `Bearer ${options.apiKey}`;
    if (options.hmacSecret) {
      Object.assign(
        h,
        signEngineRequest({
          body: bodyForSignature,
          installationId,
          secret: options.hmacSecret,
        }),
      );
    }
    // Continue the active trace across the process boundary (gate#161). Injected
    // LAST, from inside the engine-call span, so `traceparent` names that span as
    // parent. `propagation.inject` emits a standards-valid carrier for a valid
    // active context and nothing otherwise; it never overwrites auth/HMAC.
    injectTraceContext(h);
    return h;
  };

  const withTimeout = async (
    fn: (signal: AbortSignal) => Promise<Response>,
    external?: AbortSignal,
  ): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    // Abort the in-flight request on either the timeout or supersession (§15.3).
    const signal = external ? AbortSignal.any([controller.signal, external]) : controller.signal;
    try {
      return await fn(signal);
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    async submit(submission: JobSubmission, abortSignal?: AbortSignal): Promise<SubmitResponse> {
      // Each network call runs in its own engine-call span, so `traceparent`
      // names a fresh parent span id under the one review trace (gate#161).
      return withSpan(SPAN_NAMES.engineCall, async (span) => {
        span.setAttribute("engine.op", "submit");
        const body = JSON.stringify(submission);
        const requestHeaders = headers(body, submission.request.installationId);
        const res = await withTimeout(
          (signal) =>
            fetchImpl(`${base}/jobs`, {
              method: "POST",
              headers: requestHeaders,
              body,
              signal,
            }),
          abortSignal,
        );
        if (res.status === 202 || res.status === 409) {
          // 409 is TWO different answers on the engine's wire. An exact retry of
          // a key already in flight returns `{jobId}` and means "poll that one".
          // A DIFFERENT request reusing a key already spent returns
          // `{error:"idempotency_conflict"}` with no handle, deliberately, so the
          // engine does not disclose another intent's job id. Reading `jobId` off
          // that second body yielded `undefined`, and Gate then polled
          // `GET /jobs/undefined` and reported the engine as broken. A conflict is
          // a caller error and says so here, at the call that caused it.
          const responseBody = (await parseJsonBody(res)) as { jobId?: unknown };
          if (typeof responseBody.jobId !== "string" || responseBody.jobId.length === 0) {
            throw new EngineJobError(
              `engine submit conflict: ${describeError(responseBody) ?? "idempotency_conflict"} ` +
                "(the idempotency key is already in use by a different request)",
            );
          }
          return { status: res.status, jobId: responseBody.jobId };
        }
        if (res.status === 429 || res.status === 503) {
          throw new RetryableEngineError(
            `engine submit transient ${res.status}`,
            parseRetryAfterMs(res.headers.get("retry-after")),
          );
        }
        throw new EngineJobError(await engineFailure("submit", res));
      });
    },

    async poll(jobId: string, installationId: string, abortSignal?: AbortSignal): Promise<JobStatus> {
      return withSpan(SPAN_NAMES.engineCall, async (span) => {
        span.setAttribute("engine.op", "poll");
        const res = await withTimeout(
          (signal) =>
            fetchImpl(`${base}/jobs/${encodeURIComponent(jobId)}`, {
              headers: headers("", installationId),
              signal,
            }),
          abortSignal,
        );
        if (!res.ok) throw new EngineJobError(await engineFailure("poll", res));
        const status = (await res.json()) as JobStatus;
        if (status.state === "completed") {
          // Validate the contract before the result can ever reach publish (#46).
          const parsed = parseEngineResult(status.result, res.headers.get("x-schema-version"));
          if (!parsed.ok) {
            throw new EngineJobError(`engine result contract violation: ${parsed.reason}`);
          }
          return { ...status, result: parsed.result };
        }
        return status;
      });
    },

    async cancel(jobId: string, installationId: string): Promise<void> {
      return withSpan(SPAN_NAMES.engineCall, async (span) => {
        span.setAttribute("engine.op", "cancel");
        const res = await withTimeout((signal) =>
          fetchImpl(`${base}/jobs/${encodeURIComponent(jobId)}`, {
            method: "DELETE",
            headers: headers("", installationId),
            signal,
          }),
        );
        // Verdict returns 200 even when the job became terminal before
        // DELETE; that completion-vs-timeout race is an intentional no-op. Other
        // non-2xx responses are real cleanup failures and must reach diagnostics.
        if (!res.ok) throw new EngineJobError(await engineFailure("cancel", res));
      });
    },
  };
}
