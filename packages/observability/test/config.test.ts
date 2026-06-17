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
});

describe("dashboard config", () => {
  it("has panels for latency, queue depth, and engine error rate", () => {
    const exprs = dashboard.panels.flatMap((p) => p.targets.map((t) => t.expr)).join("\n");
    expect(exprs).toContain("gate_review_time_to_first_comment_ms_bucket");
    expect(exprs).toContain("gate_queue_depth");
    expect(exprs).toContain("gate_engine_errors_total");
  });
});
