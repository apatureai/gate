import { DEFAULT_CONFIG } from "@gate/config";
import type { GateMeasurementRequest, GateMeasurementResult } from "@gate/types";
import { describe, expect, it, vi } from "vitest";
import {
  createHttpMeasurementTransport,
  createMeasurementProbe,
  EngineJobError,
  GATE_MEASURE_INTENT_NAMESPACE,
  GATE_REVIEW_INTENT_NAMESPACE,
  idempotencyKey,
  measurementIntentKey,
  parseMeasurementResult,
  RetryableEngineError,
  SCHEMA_VERSION,
  type MeasurementJobStatus,
  type MeasurementSubmission,
  type MeasurementTransport,
} from "../src/index.js";

/**
 * The measure-only seam: capture, measure, stop.
 *
 * It exists so that recording a measurement baseline for every commit that lands
 * on a default branch is affordable. A baseline needs measured facts and nothing
 * else, and measured facts need no model, so this client asks a different
 * endpoint a different question and never touches the review path.
 *
 * The one thing it must never do is come back with a judgment. A payload
 * carrying a grade or findings means the service ran a model on a request that
 * asked it not to, and Gate refuses it rather than laundering it into a
 * baseline: stripping the fields would leave Gate holding a set it paid a model
 * call for while its own logs said no model was called.
 */

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

const request: GateMeasurementRequest = {
  installationId: "inst_1",
  repository: { owner: "acme", name: "web", defaultBranch: "main" },
  commitSha: COMMIT,
  preview: { url: "https://app.example.com/", provider: "explicit", environment: "Production" },
  config: DEFAULT_CONFIG,
};

const result: GateMeasurementResult = {
  measurements: {
    checksRun: ["contrast"],
    violations: [
      {
        kind: "contrast",
        route: "/",
        viewports: ["mobile"],
        element: "#hero .tagline",
        detail: "Contrast 2.91:1, below the 4.5:1 minimum",
        blockEligible: true,
        severity: 2,
      },
    ],
  },
  coverage: {
    routesRequested: ["/"],
    routesReviewed: ["/"],
    viewportsRequested: ["mobile"],
    viewportsReviewed: ["mobile"],
  },
  metadata: { engineVersion: "verdict@9.9.9", captureVersion: "capture@2" },
};

const clock = () => {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
};

function transportOf(states: MeasurementJobStatus[]): MeasurementTransport & {
  submissions: MeasurementSubmission[];
  polls: number;
} {
  const submissions: MeasurementSubmission[] = [];
  let polls = 0;
  const t = {
    submissions,
    get polls() {
      return polls;
    },
    async submit(submission: MeasurementSubmission) {
      submissions.push(submission);
      return { status: 202 as const, jobId: "job_1" };
    },
    async poll() {
      // A hard stop, so that removing the client's deadline FAILS a test rather
      // than hanging one: an unbounded poll loop against a fake clock spins
      // forever, and a test that never finishes reports nothing.
      if (polls > 40) throw new Error(`polled ${polls} times with no deadline`);
      const next = states[Math.min(polls, states.length - 1)]!;
      polls++;
      return next;
    },
  };
  return t as MeasurementTransport & { submissions: MeasurementSubmission[]; polls: number };
}

describe("measurementIntentKey", () => {
  it("is stable for the same repository and commit", () => {
    expect(measurementIntentKey(request)).toBe(measurementIntentKey({ ...request }));
    expect(measurementIntentKey(request)).toMatch(
      new RegExp(`^${GATE_MEASURE_INTENT_NAMESPACE}:sha256:[0-9a-f]{64}$`),
    );
  });

  it("canonicalizes owner, name and sha case", () => {
    expect(
      measurementIntentKey({
        ...request,
        repository: { owner: "ACME", name: "Web", defaultBranch: "main" },
        commitSha: COMMIT.toUpperCase(),
      }),
    ).toBe(measurementIntentKey(request));
  });

  it("is domain-separated from the review intent key", () => {
    // A measure of a commit and a review of a pull request at that commit are
    // different intents with very different costs. A shared namespace would let
    // the cheap one 409 the expensive one, or the reverse.
    const review = idempotencyKey({
      repository: { owner: "acme", name: "web" },
      pullRequest: { number: 42, headSha: COMMIT },
    });
    expect(review.startsWith(GATE_REVIEW_INTENT_NAMESPACE)).toBe(true);
    expect(measurementIntentKey(request).startsWith(GATE_MEASURE_INTENT_NAMESPACE)).toBe(true);
    expect(measurementIntentKey(request)).not.toBe(review);
  });

  it("refuses an abbreviated commit sha", () => {
    expect(() => measurementIntentKey({ ...request, commitSha: "0123456" })).toThrow(
      /40-character commit SHA/,
    );
  });
});

describe("createMeasurementProbe", () => {
  it("submits once, polls to completion and returns the measured facts", async () => {
    const transport = transportOf([
      { jobId: "job_1", state: "running" },
      { jobId: "job_1", state: "completed", result },
    ]);
    const c = clock();
    const probe = createMeasurementProbe(transport, c);

    await expect(probe.measure(request)).resolves.toEqual(result);
    expect(transport.submissions).toHaveLength(1);
    expect(transport.submissions[0]!.idempotencyKey).toBe(measurementIntentKey(request));
    expect(transport.submissions[0]!.request).toBe(request);
  });

  it("does not retry a submit that fails", async () => {
    const submit = vi.fn(async () => {
      throw new EngineJobError("measure submit failed: 503");
    });
    const probe = createMeasurementProbe({ submit, poll: async () => ({ jobId: "x", state: "failed" }) });

    await expect(probe.measure(request)).rejects.toThrow(/503/);
    // One push, one attempt. Retrying here would multiply a bad minute on a busy
    // default branch into a stampede against an already-failing engine.
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("raises the engine's own reason when the job fails", async () => {
    const transport = transportOf([{ jobId: "job_1", state: "failed", error: "capture_timeout" }]);
    const probe = createMeasurementProbe(transport, clock());

    await expect(probe.measure(request)).rejects.toThrow(/capture_timeout/);
  });

  it("refuses a completed job that carries no result", async () => {
    // "Completed" with nothing in it would otherwise become an empty baseline,
    // which reads to every later comparison as "measured, and clean".
    const transport = transportOf([{ jobId: "job_1", state: "completed" }]);
    const probe = createMeasurementProbe(transport, clock());

    await expect(probe.measure(request)).rejects.toThrow(/no measurement result/);
  });

  it("gives up at the deadline instead of polling forever", async () => {
    const transport = transportOf([{ jobId: "job_1", state: "running" }]);
    const c = clock();
    const probe = createMeasurementProbe(transport, { ...c, deadlineMs: 60_000 });

    await expect(probe.measure(request)).rejects.toThrow(/did not finish within 60000ms/);
    expect(transport.polls).toBeLessThan(6);
  });
});

describe("parseMeasurementResult", () => {
  it("accepts a measure-only payload", () => {
    const parsed = parseMeasurementResult(result, SCHEMA_VERSION);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.result.measurements.violations).toHaveLength(1);
  });

  it.each(["grade", "findings", "overall", "provenance"] as const)(
    "refuses a payload carrying %s, because only a judged run has one",
    (field) => {
      const judged = { ...result, [field]: field === "findings" ? [] : "ship" };
      const parsed = parseMeasurementResult(judged, SCHEMA_VERSION);

      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.reason).toBe(`judged_field_on_measure_result: ${field}`);
    },
  );

  it("refuses a payload with no measurement report", () => {
    const { measurements: _dropped, ...withoutMeasurements } = result;
    const parsed = parseMeasurementResult(withoutMeasurements, SCHEMA_VERSION);

    expect(parsed.ok).toBe(false);
  });

  it("refuses a missing schema version, and says the header was missing", () => {
    // "The service sent no version" and "the service sent a version Gate cannot
    // read" are different operator problems with different fixes, and the reason
    // string is the only place the difference survives.
    const parsed = parseMeasurementResult(result, null);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toBe("schema_version_mismatch: missing x-schema-version header");
  });

  it("refuses a mismatched schema major, and shows the value it saw", () => {
    const parsed = parseMeasurementResult(result, "2.1");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain("unsupported schema version 2.1");
  });

  it("refuses anything that is not an object", () => {
    expect(parseMeasurementResult(null, SCHEMA_VERSION).ok).toBe(false);
    expect(parseMeasurementResult("measured", SCHEMA_VERSION).ok).toBe(false);
  });
});

describe("createHttpMeasurementTransport", () => {
  const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });

  it("submits to /measurements, not to /jobs", async () => {
    // The path is the guarantee. A service that has not implemented measure-only
    // answers 404 here, which records no baseline and spends nothing; a flag on
    // the review request would have been STRIPPED by that same service, which
    // would have run a full review and billed a model call for every push.
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      calls.push(String(url));
      return jsonResponse(202, { jobId: "job_9" });
    });
    const transport = createHttpMeasurementTransport({
      baseUrl: "https://engine.example.com",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await transport.submit({ idempotencyKey: "k", request });
    expect(calls).toEqual(["https://engine.example.com/measurements"]);
  });

  it("signs the body with the same HMAC the review transport uses", async () => {
    let headers: Record<string, string> = {};
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      headers = (init?.headers ?? {}) as Record<string, string>;
      return jsonResponse(202, { jobId: "job_9" });
    });
    const transport = createHttpMeasurementTransport({
      baseUrl: "https://engine.example.com",
      hmacSecret: "s3cret",
      apiKey: "key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await transport.submit({ idempotencyKey: "k", request });
    expect(headers["x-gate-signature"]).toMatch(/^sha256=/);
    expect(headers["x-gate-installation"]).toBe("inst_1");
    expect(headers["authorization"]).toBe("Bearer key");
  });

  it("polls /measurements/:id and parses the completed result", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      calls.push(String(url));
      return jsonResponse(
        200,
        { jobId: "job_9", state: "completed", result },
        { "x-schema-version": SCHEMA_VERSION },
      );
    });
    const transport = createHttpMeasurementTransport({
      baseUrl: "https://engine.example.com/",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const status = await transport.poll("job_9", "inst_1");
    expect(calls).toEqual(["https://engine.example.com/measurements/job_9"]);
    expect(status.result?.measurements.checksRun).toEqual(["contrast"]);
  });

  it("refuses a poll that answers with a judged result", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        200,
        { jobId: "job_9", state: "completed", result: { ...result, grade: "ship", findings: [] } },
        { "x-schema-version": SCHEMA_VERSION },
      ),
    );
    const transport = createHttpMeasurementTransport({
      baseUrl: "https://engine.example.com",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(transport.poll("job_9", "inst_1")).rejects.toThrow(/judged_field_on_measure_result/);
  });

  it("reports a service that does not implement the endpoint as a rejection, not an outage", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(404, { error: "not_found" }));
    const transport = createHttpMeasurementTransport({
      baseUrl: "https://engine.example.com",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(transport.submit({ idempotencyKey: "k", request })).rejects.toThrow(
      /measure submit failed: 404 \(not_found\)/,
    );
  });

  it("carries Retry-After on a transient status", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("", { status: 503, headers: { "retry-after": "12" } }),
    );
    const transport = createHttpMeasurementTransport({
      baseUrl: "https://engine.example.com",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(transport.submit({ idempotencyKey: "k", request })).rejects.toBeInstanceOf(
      RetryableEngineError,
    );
  });

  it("treats a 409 with no job id as a failure rather than polling `undefined`", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(409, { error: "idempotency_conflict" }));
    const transport = createHttpMeasurementTransport({
      baseUrl: "https://engine.example.com",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(transport.submit({ idempotencyKey: "k", request })).rejects.toThrow(
      /measure submit failed: 409/,
    );
  });
});
