import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const observabilityDir = fileURLToPath(new URL("../../../observability/", import.meta.url));
const alerts = readFileSync(`${observabilityDir}alerts.yaml`, "utf8");
const dashboard = JSON.parse(readFileSync(`${observabilityDir}dashboard.json`, "utf8")) as {
  panels: Array<{ title: string; targets: Array<{ expr: string }> }>;
};

describe("alert config", () => {
  it("alerts when the stale-publish rate is above zero", () => {
    expect(alerts).toContain("GateStalePublish");
    expect(alerts).toContain("gate_stale_publish_total");
    expect(alerts).toMatch(/gate_stale_publish_total\[5m\]\)\s*>\s*0/);
  });

  it("covers latency and engine error SLOs", () => {
    expect(alerts).toContain("gate_review_time_to_first_comment_ms_bucket");
    expect(alerts).toContain("gate_engine_errors_total");
  });

  it("alerts on the number that would reverse the measurement decision", () => {
    // The decision to keep measured facts out of the grade named a threshold and
    // a reversal. Both belong in the alert an operator actually receives, not
    // only in the doc comment beside the counter.
    expect(alerts).toContain("GateGreenOverMeasuredHigh");
    expect(alerts).toContain("gate_review_green_over_measured_total");
    // Against graded runs, not against every published review.
    expect(alerts).toContain('gate_review_published_total{graded="true"}');
    expect(alerts).toContain("> 0.05");
  });

  it("alerts on a measured kind repositories keep muting", () => {
    expect(alerts).toContain("GateMeasurementSuppressionHigh");
    expect(alerts).toContain("gate_review_measurement_suppressed_total");
    expect(alerts).toContain("gate_review_measurements_published_total");
    expect(alerts).toContain("> 0.15");
  });
});

describe("dashboard config", () => {
  it("has panels for latency, queue depth, and engine error rate", () => {
    const exprs = dashboard.panels.flatMap((p) => p.targets.map((t) => t.expr)).join("\n");
    expect(exprs).toContain("gate_review_time_to_first_comment_ms_bucket");
    expect(exprs).toContain("gate_queue_depth");
    expect(exprs).toContain("gate_engine_errors_total");
  });

  it("has a panel for green-over-measured and the measured kinds behind it", () => {
    const exprs = dashboard.panels.flatMap((p) => p.targets.map((t) => t.expr)).join("\n");
    expect(exprs).toContain("gate_review_green_over_measured_total");
    expect(exprs).toContain("gate_review_published_total");
    expect(exprs).toContain("gate_review_measurements_published_total");
    expect(exprs).toContain("gate_review_measurement_suppressed_total");
  });
});
