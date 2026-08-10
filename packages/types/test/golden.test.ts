import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  goldenReviewResultPath,
  hasDisplayableConfidence,
  loadGoldenReviewResult,
  loadPreCalibrationReviewResult,
  preCalibrationReviewResultPath,
} from "../src/index.js";
import type {
  Finding,
  GateReviewResult,
  ReviewGrade,
  Severity,
} from "../src/index.js";

const GRADES: ReviewGrade[] = ["ship", "ship_with_nits", "needs_work", "blocked"];
const SEVERITIES: Severity[] = ["nit", "minor", "major", "blocker"];
// Re-pinned for the CalibrationReportV1 provenance contract (#166 / JE #160).
const GATE_ENGINE_GOLDEN_BLOB = "54a7add15f3431964f092f9795af2a72800d33a0";
const GATE_ENGINE_PRE_CALIBRATION_BLOB = "7d1c7e4780b5967c1df937f12667875e4d38ffb8";

describe("golden GateReviewResult fixture", () => {
  // Compile-time guarantee: the loader's return type IS GateReviewResult.
  const golden: GateReviewResult = loadGoldenReviewResult();

  it("has a valid grade", () => {
    expect(GRADES).toContain(golden.grade);
  });

  it("has a non-empty overall summary", () => {
    expect(typeof golden.overall).toBe("string");
    expect(golden.overall.length).toBeGreaterThan(0);
  });

  it("is byte-identical to the pinned Judgment Engine golden fixture", () => {
    const bytes = readFileSync(goldenReviewResultPath());
    const oid = createHash("sha1")
      .update(`blob ${bytes.length}\0`)
      .update(bytes)
      .digest("hex");
    expect(oid).toBe(GATE_ENGINE_GOLDEN_BLOB);
  });

  it("pins the exact historical pre-report counterexample", () => {
    const bytes = readFileSync(preCalibrationReviewResultPath());
    const oid = createHash("sha1")
      .update(`blob ${bytes.length}\0`)
      .update(bytes)
      .digest("hex");
    expect(oid).toBe(GATE_ENGINE_PRE_CALIBRATION_BLOB);
    const historical = loadPreCalibrationReviewResult();
    expect(typeof historical.confidence).toBe("number");
    expect(historical.calibration).toBeUndefined();
    expect(hasDisplayableConfidence(historical)).toBe(false);
  });

  it("has structurally valid findings", () => {
    expect(Array.isArray(golden.findings)).toBe(true);
    for (const f of golden.findings as Finding[]) {
      expect(typeof f.id).toBe("string");
      expect(SEVERITIES).toContain(f.severity);
      expect(typeof f.title).toBe("string");
      expect(typeof f.description).toBe("string");
      expect(typeof f.route).toBe("string");
      expect(["mobile", "tablet", "desktop"]).toContain(f.viewport);
      expect(f.element === null || typeof f.element === "string").toBe(true);
      expect(f.screenshotId === null || typeof f.screenshotId === "string").toBe(true);
      expect(f.suggestion === null || typeof f.suggestion === "string").toBe(true);
      expect(f.confidence === undefined || (f.confidence >= 0 && f.confidence <= 1)).toBe(true);
    }
  });

  it("exposes notReviewed as an array of strings", () => {
    expect(Array.isArray(golden.notReviewed)).toBe(true);
    for (const n of golden.notReviewed) expect(typeof n).toBe("string");
  });

  it("carries amended artifact + retention fields (TRD §15.2)", () => {
    expect(Array.isArray(golden.artifacts.annotatedScreenshots)).toBe(true);
    expect(typeof golden.screenshotRetentionSeconds).toBe("number");
    expect(golden.screenshotRetentionSeconds).toBeGreaterThan(0);
    // §15.2: the public runUrl is built by Gate, not carried by the engine result.
    expect("runUrl" in golden.artifacts).toBe(false);
  });

  it("annotated screenshots reference real findings", () => {
    const findingIds = new Set(golden.findings.map((f) => f.id));
    for (const shot of golden.artifacts.annotatedScreenshots) {
      expect(findingIds.has(shot.findingId)).toBe(true);
      expect(typeof shot.url).toBe("string");
    }
  });

  it("metadata is engine-neutral and traceable (no Claude-specific fields)", () => {
    const { metadata } = golden;
    expect(typeof metadata.engineVersion).toBe("string");
    expect(typeof metadata.model).toBe("string");
    expect(typeof metadata.promptVersion).toBe("string");
    expect(typeof metadata.captureVersion).toBe("string");
    expect(metadata.uiDnaVersion === null || typeof metadata.uiDnaVersion === "string").toBe(true);

    // Gate must not hard-code Claude as the judge anywhere in the contract.
    const serialized = JSON.stringify(golden).toLowerCase();
    expect(serialized).not.toContain("claude");
    expect(serialized).not.toContain("anthropic");
  });

  it("carries calibrated confidence with exact report provenance and no Gate-owned fallback", () => {
    expect(golden.confidence).toBe(0.7);
    expect(golden.findings.map((finding) => finding.confidence)).toEqual([0.92, 0.85, 0.7]);
    expect(golden.calibration).toMatchObject({
      reportId: "calibration_qwen3vl_2026_07",
      calibrationVersion: "isotonic@1",
      confidenceSource: "post_hoc_isotonic",
    });
    expect(golden.calibration?.reportHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(golden.blockingEnabled).toBe(true);
    expect(hasDisplayableConfidence(golden)).toBe(true);
  });
});
