import { loadGoldenReviewResult } from "@gate/types";
import { describe, expect, it } from "vitest";
import { parseEngineResult, SCHEMA_VERSION } from "../src/index.js";

const golden = loadGoldenReviewResult();

describe("finding.dimension preservation (judgment-engine#159 consumer)", () => {
  it("preserves the engine's rubric dimension through parseEngineResult", () => {
    const body = {
      ...golden,
      findings: golden.findings.map((f, i) => ({ ...f, dimension: i === 0 ? "accessibility" : "spacing" })),
    };
    const out = parseEngineResult(body, SCHEMA_VERSION);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.result.findings[0]!.dimension).toBe("accessibility"); // verbatim, not synthesized
      expect(out.result.findings[1]?.dimension ?? "spacing").toBe("spacing");
    }
  });

  it("accepts a legacy finding with no dimension (additive, optional-on-read)", () => {
    const body = { ...golden, findings: golden.findings.map((f) => ({ ...f, dimension: undefined })) };
    const out = parseEngineResult(body, SCHEMA_VERSION);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.result.findings[0]!.dimension).toBeUndefined();
  });

  it("rejects an unknown dimension value (closed enum)", () => {
    const body = { ...golden, findings: golden.findings.map((f) => ({ ...f, dimension: "made_up_dimension" })) };
    const out = parseEngineResult(body, SCHEMA_VERSION);
    expect(out.ok).toBe(false);
  });

  it("the dimension never changes the grade — it is preserved alongside an unchanged verdict", () => {
    const body = { ...golden, findings: golden.findings.map((f) => ({ ...f, dimension: "brand" })) };
    const out = parseEngineResult(body, SCHEMA_VERSION);
    expect(out.ok && out.result.grade).toBe(golden.grade);
  });
});
