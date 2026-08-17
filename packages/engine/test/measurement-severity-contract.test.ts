import { loadMeasuredReviewResult } from "@gate/types";
import { describe, expect, it } from "vitest";
import { parseEngineResult, SCHEMA_VERSION } from "../src/index.js";

/**
 * The engine's severity band has to SURVIVE the parser, and that is the whole
 * risk here.
 *
 * `GateReviewResultSchema` is deliberately not `.strict()`, so a field it does
 * not name is stripped: silently, with no error and no log line. A band that
 * never survives parsing is a band Gate never has, and Gate would go on
 * reporting a contrast ratio that fell from 2.91:1 to 1.02:1 as an unchanged
 * pre-existing violation, which is exactly the defect the field exists to close.
 *
 * The other direction is pinned just as hard: a band Gate cannot read must
 * degrade to ABSENT rather than fail the parse. Absent means unknown, and
 * unknown never gates, so the worst a bad value can do is switch the comparison
 * off. A parse failure would block publishing the review altogether.
 */

const measured = loadMeasuredReviewResult();

const withViolation = (over: Record<string, unknown>) => ({
  ...measured,
  measurements: {
    checksRun: ["contrast"],
    violations: [
      {
        kind: "contrast",
        route: "/pricing",
        viewports: ["mobile"],
        element: "#hero-subtitle",
        detail: "text contrast 2.91:1 is below WCAG AA 4.5:1",
        blockEligible: true,
        ...over,
      },
    ],
  },
});

const parseOne = (over: Record<string, unknown>) => {
  const out = parseEngineResult(withViolation(over), SCHEMA_VERSION);
  expect(out.ok).toBe(true);
  if (!out.ok) throw new Error("expected the payload to parse");
  return out.result.measurements?.violations[0];
};

describe("the engine's severity band crosses the contract", () => {
  it("keeps the band the engine stated instead of stripping it", () => {
    expect(parseOne({ severity: 3 })?.severity).toBe(3);
    expect(parseOne({ severity: 1 })?.severity).toBe(1);
  });

  it("reads a violation with no band as absent, not as zero", () => {
    // An engine that predates the field, or a check that computes no band. The
    // difference between `undefined` and `0` is the difference between "unknown"
    // and "the best band there is", and only one of them is honest.
    const violation = parseOne({});
    expect(violation?.severity).toBeUndefined();
    expect(violation).not.toHaveProperty("severity", 0);
  });

  it("keeps the whole result parsing when the band is a value Gate cannot read", () => {
    // Every one of these degrades to unknown rather than blocking the publish.
    // A magnitude that leaked into the field is the case worth naming: `2.91` is
    // a contrast ratio, not a band, and comparing bands against it would be the
    // engine's numbers crossing the boundary that keeps them out.
    for (const bad of [2.91, 0, -1, "3", null, true, {}]) {
      expect(parseOne({ severity: bad })?.severity).toBeUndefined();
    }
  });

  it("does not invent a band for an engine that never sends one", () => {
    const out = parseEngineResult(measured, SCHEMA_VERSION);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    for (const violation of out.result.measurements?.violations ?? []) {
      expect(violation.severity).toBeUndefined();
    }
  });
});
