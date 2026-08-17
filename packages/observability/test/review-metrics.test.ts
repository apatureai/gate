import {
  AggregationTemporality,
  InMemoryMetricExporter,
  type MetricData,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GateMetrics,
  initTelemetry,
  METRIC_NAMES,
  PUBLISHED_REVIEW_EVENT,
  recordPublishedReview,
  REVIEW_METRIC_PREFIX,
  resetSharedMetrics,
  type Telemetry,
} from "../src/index.js";

/**
 * The reversal instrument, wired.
 *
 * `gate.review.green_over_measured` was named as the one number that would
 * reverse the decision to keep measurements out of the grade, and it was
 * computed correctly by a class nothing in the product ever constructed. These
 * tests hold both halves of the fix: the OpenTelemetry counter for an operator
 * with a collector, and the one greppable line for the self-hoster who has
 * neither.
 */

let telemetry: Telemetry | undefined;

afterEach(async () => {
  await telemetry?.shutdown();
  telemetry = undefined;
  resetSharedMetrics();
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

function meteredRun() {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 });
  telemetry = initTelemetry({ metricReaders: [reader] });
  return {
    exporter,
    metrics: new GateMetrics(telemetry.meterProvider.getMeter("test")),
    flush: () => (telemetry as Telemetry).meterProvider.forceFlush(),
  };
}

describe("gate.review.green_over_measured, recorded", () => {
  it("increments on a green check published over a block-eligible measured violation", async () => {
    const run = meteredRun();
    const log = vi.fn();

    recordPublishedReview(
      {
        conclusion: "success",
        graded: true,
        greenOverMeasured: true,
        measurementKinds: ["contrast"],
        repository: "acme/web",
        pullRequest: 42,
      },
      { metrics: run.metrics, log },
    );
    await run.flush();

    const counter = collectMetric(run.exporter, METRIC_NAMES.greenOverMeasured);
    expect(counter?.dataPoints[0]?.value).toBe(1);
    expect(counter?.dataPoints[0]?.attributes).toMatchObject({ conclusion: "success" });
  });

  it("does not increment when the review was not green over a measurement", async () => {
    const run = meteredRun();

    recordPublishedReview(
      { conclusion: "neutral", graded: false, greenOverMeasured: false, measurementKinds: ["contrast"] },
      { metrics: run.metrics, log: vi.fn() },
    );
    await run.flush();

    // Absent, not zero: nothing ever added to it.
    expect(collectMetric(run.exporter, METRIC_NAMES.greenOverMeasured)).toBeUndefined();
    // The denominator's kind counter still moved, so the rate has a floor.
    expect(collectMetric(run.exporter, METRIC_NAMES.measurementsPublished)?.dataPoints[0]?.value).toBe(1);
  });

  it("treats an absent flag as not-green rather than as truthy", async () => {
    const run = meteredRun();

    recordPublishedReview({ conclusion: "success" }, { metrics: run.metrics, log: vi.fn() });
    await run.flush();

    expect(collectMetric(run.exporter, METRIC_NAMES.greenOverMeasured)).toBeUndefined();
  });

  it("counts every published review, split by graded, so the rate has a denominator", async () => {
    const run = meteredRun();
    const log = vi.fn();

    recordPublishedReview({ conclusion: "success", graded: true, greenOverMeasured: true }, { metrics: run.metrics, log });
    recordPublishedReview({ conclusion: "neutral", graded: true }, { metrics: run.metrics, log });
    recordPublishedReview({ conclusion: "neutral", graded: false }, { metrics: run.metrics, log });
    await run.flush();

    const published = collectMetric(run.exporter, METRIC_NAMES.reviewsPublished);
    const byGraded = new Map<unknown, number>();
    for (const point of published?.dataPoints ?? []) {
      byGraded.set(point.attributes.graded, (byGraded.get(point.attributes.graded) ?? 0) + point.value);
    }
    expect(byGraded.get(true)).toBe(2);
    expect(byGraded.get(false)).toBe(1);
    expect(collectMetric(run.exporter, METRIC_NAMES.greenOverMeasured)?.dataPoints[0]?.value).toBe(1);
  });

  it("counts published and suppressed measurements by kind", async () => {
    const run = meteredRun();

    recordPublishedReview(
      {
        conclusion: "neutral",
        graded: true,
        measurementKinds: ["contrast", "contrast", "overflow"],
        suppressedMeasurementKinds: ["touch_target"],
      },
      { metrics: run.metrics, log: vi.fn() },
    );
    await run.flush();

    const published = collectMetric(run.exporter, METRIC_NAMES.measurementsPublished);
    const byKind = Object.fromEntries(
      (published?.dataPoints ?? []).map((point) => [point.attributes.kind, point.value]),
    );
    expect(byKind).toEqual({ contrast: 2, overflow: 1 });

    const suppressed = collectMetric(run.exporter, METRIC_NAMES.measurementSuppressed);
    expect(suppressed?.dataPoints[0]?.attributes).toMatchObject({ kind: "touch_target" });
    expect(suppressed?.dataPoints[0]?.value).toBe(1);
  });
});

describe("the line a self-hoster greps", () => {
  const facts = {
    conclusion: "success",
    graded: true,
    greenOverMeasured: true,
    measurementKinds: ["overflow", "contrast", "contrast"],
    suppressedMeasurementKinds: ["touch_target"],
    repository: "acme/web",
    pullRequest: 42,
    headSha: "0123456789abcdef",
  };

  it("emits one stable-prefix line carrying the numerator and the denominator", () => {
    const log = vi.fn();
    const line = recordPublishedReview(facts, { metrics: new GateMetrics(), log });

    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0][0]).toBe(line);
    expect(line.startsWith(`${REVIEW_METRIC_PREFIX} ${PUBLISHED_REVIEW_EVENT} `)).toBe(true);
    expect(line).toContain("conclusion=success");
    expect(line).toContain("graded=true");
    expect(line).toContain("green_over_measured=true");
    expect(line).toContain("repo=acme/web");
    expect(line).toContain("pr=42");
    expect(line).toContain("sha=0123456789abcdef");
  });

  it("counts the kinds in a stable order, so the field is diffable across runs", () => {
    const line = recordPublishedReview(facts, { metrics: new GateMetrics(), log: vi.fn() });

    expect(line).toContain("measured=contrast:2,overflow:1");
    expect(line).toContain("measured_suppressed=touch_target:1");
  });

  it("prints both booleans on every review, so grep -c has a denominator", () => {
    const line = recordPublishedReview(
      { conclusion: "neutral", graded: false, greenOverMeasured: false },
      { metrics: new GateMetrics(), log: vi.fn() },
    );

    // A field that disappeared when false would make `grep -c graded=true` right
    // and `grep -c graded=false` silently wrong.
    expect(line).toContain("graded=false");
    expect(line).toContain("green_over_measured=false");
    expect(line).toContain("measured=");
  });

  it("stays one line when a repository name carries a newline", () => {
    // The repository and SHA reach here off a webhook payload. A newline in
    // either would forge a second `[gate.metric]` line and make an operator's
    // `grep -c` count a review that never happened.
    const line = recordPublishedReview(
      {
        conclusion: "success",
        greenOverMeasured: false,
        repository: "acme/web\n[gate.metric] gate.review.published green_over_measured=true",
      },
      { metrics: new GateMetrics(), log: vi.fn() },
    );

    expect(line.includes("\n")).toBe(false);
    expect(line.match(/green_over_measured=true/g)).toBeNull();
  });

  it("defaults to console.info, so a self-hoster gets it with nothing configured", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      recordPublishedReview({ conclusion: "success" }, { metrics: new GateMetrics() });
      expect(info).toHaveBeenCalledOnce();
      expect(String(info.mock.calls[0][0])).toContain(REVIEW_METRIC_PREFIX);
    } finally {
      info.mockRestore();
    }
  });
});
