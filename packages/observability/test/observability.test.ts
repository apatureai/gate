import {
  AggregationTemporality,
  InMemoryMetricExporter,
  type MetricData,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it } from "vitest";
import {
  GateMetrics,
  initTelemetry,
  METRIC_NAMES,
  SPAN_NAMES,
  withSpan,
  type Telemetry,
} from "../src/index.js";

let telemetry: Telemetry | undefined;

afterEach(async () => {
  await telemetry?.shutdown();
  telemetry = undefined;
});

function collectMetric(exporter: InMemoryMetricExporter, name: string): MetricData | undefined {
  for (const rm of exporter.getMetrics()) {
    for (const sm of rm.scopeMetrics) {
      for (const metric of sm.metrics) {
        if (metric.descriptor.name === name) return metric;
      }
    }
  }
  return undefined;
}

describe("GateMetrics", () => {
  it("records the stale-publish invariant and review latency", async () => {
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 });
    telemetry = initTelemetry({ metricReaders: [reader] });

    const m = new GateMetrics(telemetry.meterProvider.getMeter("test"));
    m.recordStalePublish({ reason: "sha_changed" });
    m.recordReviewLatency(1234);
    m.recordEngineError();
    m.setQueueDepthProvider(() => 3);

    await telemetry.meterProvider.forceFlush();

    const stale = collectMetric(exporter, METRIC_NAMES.stalePublish);
    expect(stale?.dataPoints[0]?.value).toBe(1);

    const latency = collectMetric(exporter, METRIC_NAMES.reviewLatency);
    expect(latency).toBeDefined();

    const queueDepth = collectMetric(exporter, METRIC_NAMES.queueDepth);
    expect(queueDepth?.dataPoints[0]?.value).toBe(3);
  });
});

describe("withSpan", () => {
  it("creates a span for a pipeline stage and records errors", async () => {
    const exporter = new InMemorySpanExporter();
    telemetry = initTelemetry({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    const tracer = telemetry.tracerProvider.getTracer("test");

    await withSpan(SPAN_NAMES.engineCall, async () => "ok", tracer);
    await expect(
      withSpan(SPAN_NAMES.publishGuard, async () => {
        throw new Error("boom");
      }, tracer),
    ).rejects.toThrow("boom");

    const spans = exporter.getFinishedSpans();
    const names = spans.map((s) => s.name);
    expect(names).toContain(SPAN_NAMES.engineCall);
    expect(names).toContain(SPAN_NAMES.publishGuard);

    const guard = spans.find((s) => s.name === SPAN_NAMES.publishGuard);
    expect(guard?.status.code).toBe(2); // SpanStatusCode.ERROR
  });
});
