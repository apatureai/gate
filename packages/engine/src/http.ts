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

  const headers = (): Record<string, string> => {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (options.apiKey) h["authorization"] = `Bearer ${options.apiKey}`;
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
      const body = JSON.stringify(submission);
      const requestHeaders = headers();
      if (options.hmacSecret) {
        Object.assign(
          requestHeaders,
          signEngineRequest({
            body,
            installationId: submission.request.installationId,
            secret: options.hmacSecret,
          }),
        );
      }
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
        const body = (await res.json()) as { jobId: string };
        return { status: res.status, jobId: body.jobId };
      }
      if (res.status === 429 || res.status === 503) {
        throw new RetryableEngineError(
          `engine submit transient ${res.status}`,
          parseRetryAfterMs(res.headers.get("retry-after")),
        );
      }
      throw new EngineJobError(`engine submit failed: ${res.status}`);
    },

    async poll(jobId: string, abortSignal?: AbortSignal): Promise<JobStatus> {
      const res = await withTimeout(
        (signal) => fetchImpl(`${base}/jobs/${encodeURIComponent(jobId)}`, { headers: headers(), signal }),
        abortSignal,
      );
      if (!res.ok) throw new EngineJobError(`engine poll failed: ${res.status}`);
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
    },

    async cancel(jobId: string): Promise<void> {
      await withTimeout((signal) =>
        fetchImpl(`${base}/jobs/${encodeURIComponent(jobId)}`, {
          method: "DELETE",
          headers: headers(),
          signal,
        }),
      );
    },
  };
}
