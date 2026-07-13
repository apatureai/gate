import { context, trace } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { injectTraceContext, traceContextHeaders } from "../src/index.js";

const TRACEPARENT = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

let provider: NodeTracerProvider;

beforeAll(() => {
  provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(new InMemorySpanExporter())] });
  provider.register(); // registers the default W3C trace-context propagator globally
});
afterAll(async () => {
  await provider.shutdown();
});

describe("W3C trace-context injection (gate#161)", () => {
  it("emits a standards-valid traceparent naming the active span", () => {
    const tracer = trace.getTracer("test");
    const span = tracer.startSpan("s");
    context.with(trace.setSpan(context.active(), span), () => {
      const h = traceContextHeaders();
      expect(h["traceparent"]).toMatch(TRACEPARENT);
      // the carrier's trace id + parent id are the active span's context
      const ctx = span.spanContext();
      expect(h["traceparent"]).toContain(ctx.traceId);
      expect(h["traceparent"]).toContain(ctx.spanId);
    });
    span.end();
  });

  it("does not forward anything when there is no active span (malformed/absent ambient context ignored)", () => {
    // root context has no valid span → the propagator emits no traceparent
    const h = traceContextHeaders();
    expect(h["traceparent"]).toBeUndefined();
  });

  it("never overwrites existing carrier headers", () => {
    const carrier = { "content-type": "application/json", authorization: "Bearer x" };
    injectTraceContext(carrier);
    expect(carrier["content-type"]).toBe("application/json");
    expect(carrier["authorization"]).toBe("Bearer x");
  });
});
