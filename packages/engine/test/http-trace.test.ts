import { context, trace } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHttpEngineTransport } from "../src/http.js";
import type { JobSubmission } from "../src/jobs.js";

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;

let provider: NodeTracerProvider;
beforeAll(() => {
  provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(new InMemorySpanExporter())] });
  provider.register();
});
afterAll(async () => {
  await provider.shutdown();
});

/** A fake fetch that records the traceparent header of every call. */
function recordingFetch(captured: string[]): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    const h = (init?.headers ?? {}) as Record<string, string>;
    captured.push(h["traceparent"] ?? "");
    return {
      status: 202,
      ok: true,
      json: async () => ({ jobId: "job_1", state: "working" }),
      headers: { get: () => null },
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

const submission: JobSubmission = {
  idempotencyKey: "42:abc",
  depth: "triage",
  request: { installationId: "inst_1" } as never,
};

describe("engine transport propagates W3C trace context (gate#161)", () => {
  it("injects a valid traceparent on submit, poll, and cancel", async () => {
    const captured: string[] = [];
    const transport = createHttpEngineTransport({ baseUrl: "https://engine.test", fetchImpl: recordingFetch(captured) });

    const tracer = trace.getTracer("test");
    const root = tracer.startSpan("gate.review");
    await context.with(trace.setSpan(context.active(), root), async () => {
      await transport.submit(submission);
      await transport.poll("job_1", "inst_1");
      await transport.cancel("job_1", "inst_1");
    });
    root.end();

    expect(captured).toHaveLength(3);
    const parsed = captured.map((tp) => TRACEPARENT.exec(tp));
    // every call emitted a standards-valid carrier
    expect(parsed.every((m) => m !== null)).toBe(true);
    // one review trace: all three share the root trace id
    const traceIds = new Set(parsed.map((m) => m![1]));
    expect(traceIds).toEqual(new Set([root.spanContext().traceId]));
    // fresh parent span id per call (each ran in its own engine-call span)
    const parentIds = parsed.map((m) => m![2]);
    expect(new Set(parentIds).size).toBe(3);
    expect(parentIds).not.toContain(root.spanContext().spanId);
  });

  it("with no ambient trace, its own engine-call span still yields a standards-valid carrier (never malformed)", async () => {
    // The transport always runs the call in its own engine-call span, so it emits
    // a fresh valid traceparent rather than echoing/forwarding an ambient one.
    const captured: string[] = [];
    const transport = createHttpEngineTransport({ baseUrl: "https://engine.test", fetchImpl: recordingFetch(captured) });
    await transport.submit(submission); // no ambient parent span
    expect(captured[0]).toMatch(TRACEPARENT);
  });
});
