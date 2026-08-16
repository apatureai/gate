import {
  hasDisplayableConfidence,
  loadGoldenReviewResult,
  loadPreCalibrationReviewResult,
} from "@gate/types";
import type { GateReviewResult } from "@gate/types";
import { describe, expect, it } from "vitest";
import {
  createHttpEngineTransport,
  GateReviewResultSchema,
  parseEngineResult,
  SCHEMA_VERSION,
} from "../src/index.js";

const golden = loadGoldenReviewResult();

describe("GateReviewResult contract", () => {
  it("the golden fixture parses and the schema output IS GateReviewResult", () => {
    const result: GateReviewResult = GateReviewResultSchema.parse(golden);
    expect(result.grade).toBe(golden.grade);
    expect(result.metadata.uiDnaVersion).toBe(golden.metadata.uiDnaVersion);
  });

  it("accepts a matching major version (additive minor ok)", () => {
    expect(parseEngineResult(golden, SCHEMA_VERSION).ok).toBe(true);
    expect(parseEngineResult(golden, `${SCHEMA_VERSION}.4.2`).ok).toBe(true);
  });

  it("accepts null uiDnaVersion (repo without extracted UI DNA)", () => {
    const out = parseEngineResult({ ...golden, metadata: { ...golden.metadata, uiDnaVersion: null } }, SCHEMA_VERSION);
    expect(out.ok).toBe(true);
  });

  it("preserves distinct engine-produced result and finding confidence values", () => {
    const out = parseEngineResult(
      {
        ...golden,
        confidence: 0.91,
        findings: golden.findings.map((finding, index) => ({
          ...finding,
          confidence: index === 0 ? 0.88 : finding.confidence,
        })),
      },
      SCHEMA_VERSION,
    );

    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.result.confidence).toBe(0.91);
      expect(out.result.findings[0]?.confidence).toBe(0.88);
    }
  });

  it("accepts confidence boundaries and rejects non-finite or out-of-range values", () => {
    expect(parseEngineResult({ ...golden, confidence: 0 }, SCHEMA_VERSION).ok).toBe(true);
    expect(parseEngineResult({ ...golden, confidence: 1 }, SCHEMA_VERSION).ok).toBe(true);
    for (const confidence of [-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(parseEngineResult({ ...golden, confidence }, SCHEMA_VERSION)).toMatchObject({
        ok: false,
        reason: "schema_parse_error",
      });
    }
  });

  it("keeps confidence unavailable when a legacy result omits it", () => {
    const { confidence: _resultConfidence, ...legacy } = golden;
    const out = parseEngineResult(
      {
        ...legacy,
        findings: legacy.findings.map(({ confidence: _findingConfidence, ...finding }) => finding),
      },
      SCHEMA_VERSION,
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.result.confidence).toBeUndefined();
      expect(out.result.findings.every((finding) => finding.confidence === undefined)).toBe(true);
    }
  });

  it("parses historical numeric fields but refuses to authorize them without provenance", () => {
    const out = parseEngineResult(loadPreCalibrationReviewResult(), SCHEMA_VERSION);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(typeof out.result.confidence).toBe("number");
      expect(hasDisplayableConfidence(out.result)).toBe(false);
    }
  });

  it("rejects malformed report provenance and withholds partial confidence", () => {
    expect(parseEngineResult({
      ...golden,
      calibration: { ...golden.calibration, reportHash: "sha256:not-a-digest" },
    }, SCHEMA_VERSION)).toMatchObject({ ok: false, reason: "schema_parse_error" });

    const out = parseEngineResult({
      ...golden,
      findings: golden.findings.map((finding, index) =>
        index === 0 ? { ...finding, confidence: undefined } : finding),
    }, SCHEMA_VERSION);
    expect(out.ok).toBe(true);
    if (out.ok) expect(hasDisplayableConfidence(out.result)).toBe(false);
  });

  it("tolerates additive unknown fields (additive-only evolution)", () => {
    const withExtra = { ...golden, futureField: "ignored" };
    const out = parseEngineResult(withExtra, SCHEMA_VERSION);
    expect(out.ok).toBe(true);
    if (out.ok) expect("futureField" in out.result).toBe(false); // stripped
  });

  it("preserves coverage through parsing instead of stripping it (verdict#165)", () => {
    // The schema is not `.strict()`, so a field it does not NAME is silently
    // dropped. Coverage that never survives the parse cannot stop a green Check
    // Run from being published over a review that touched nothing.
    const out = parseEngineResult(golden, SCHEMA_VERSION);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.result.coverage).toEqual(golden.coverage);
  });

  it("accepts a result with no coverage at all (older / third-party engine)", () => {
    const { coverage: _drop, ...withoutCoverage } = golden;
    const out = parseEngineResult(withoutCoverage, SCHEMA_VERSION);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.result.coverage).toBeUndefined();
  });

  it("rejects HALF-stated coverage rather than reading it as a weaker claim", () => {
    // `routesReviewed` with no `routesRequested` cannot tell partial from full.
    const out = parseEngineResult(
      { ...golden, coverage: { routesReviewed: ["/pricing"] } },
      SCHEMA_VERSION,
    );
    expect(out).toMatchObject({ ok: false, reason: "schema_parse_error" });
  });

  it("rejects a coverage viewport outside the closed enum", () => {
    const out = parseEngineResult(
      { ...golden, coverage: { ...golden.coverage, viewportsReviewed: ["watch"] } },
      SCHEMA_VERSION,
    );
    expect(out).toMatchObject({ ok: false, reason: "schema_parse_error" });
  });

  it("rejects an unsupported major version (degrade gracefully)", () => {
    const out = parseEngineResult(golden, "2");
    expect(out).toMatchObject({ ok: false, reason: "schema_version_mismatch" });
  });

  it("rejects a missing version header", () => {
    expect(parseEngineResult(golden, null)).toMatchObject({ ok: false, reason: "schema_version_mismatch" });
  });

  it("surfaces a typed parse error on a shape mismatch (never null-grade)", () => {
    const { grade: _removed, ...broken } = golden;
    const out = parseEngineResult(broken, SCHEMA_VERSION);
    expect(out).toMatchObject({ ok: false, reason: "schema_parse_error" });
    if (!out.ok && out.reason === "schema_parse_error") {
      expect(out.issues.join(" ")).toMatch(/grade/);
    }
  });
});

describe("http transport enforces the contract on completed jobs", () => {
  function transportWith(version: string | null, body: unknown) {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ jobId: "j", state: "completed", result: body }), {
        status: 200,
        headers: version ? { "x-schema-version": version } : {},
      })) as unknown as typeof fetch;
    return createHttpEngineTransport({ baseUrl: "https://engine.internal", fetchImpl });
  }

  it("returns the parsed result when the version + shape are valid", async () => {
    const status = await transportWith(SCHEMA_VERSION, golden).poll("j");
    expect(status.result?.grade).toBe(golden.grade);
  });

  it("throws (blocks publish) on a version mismatch", async () => {
    await expect(transportWith("2", golden).poll("j")).rejects.toThrow(/contract violation/);
  });

  it("throws on a shape mismatch", async () => {
    const { overall: _drop, ...broken } = golden;
    await expect(transportWith(SCHEMA_VERSION, broken).poll("j")).rejects.toThrow(/contract violation/);
  });
});
