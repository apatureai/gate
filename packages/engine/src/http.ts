import {
  EngineJobError,
  type EngineTransport,
  type JobStatus,
  type JobSubmission,
  type SubmitResponse,
} from "./jobs.js";

export interface HttpEngineTransportOptions {
  baseUrl: string;
  /** Bearer/API key for the engine. #47 replaces/augments this with HMAC signing. */
  apiKey?: string;
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

  const withTimeout = async (fn: (signal: AbortSignal) => Promise<Response>): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      return await fn(controller.signal);
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    async submit(submission: JobSubmission): Promise<SubmitResponse> {
      const res = await withTimeout((signal) =>
        fetchImpl(`${base}/jobs`, {
          method: "POST",
          headers: headers(),
          body: JSON.stringify(submission),
          signal,
        }),
      );
      if (res.status === 202 || res.status === 409) {
        const body = (await res.json()) as { jobId: string };
        return { status: res.status, jobId: body.jobId };
      }
      throw new EngineJobError(`engine submit failed: ${res.status}`);
    },

    async poll(jobId: string): Promise<JobStatus> {
      const res = await withTimeout((signal) =>
        fetchImpl(`${base}/jobs/${encodeURIComponent(jobId)}`, { headers: headers(), signal }),
      );
      if (!res.ok) throw new EngineJobError(`engine poll failed: ${res.status}`);
      return (await res.json()) as JobStatus;
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
