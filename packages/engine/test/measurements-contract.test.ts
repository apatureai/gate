import { loadGoldenReviewResult, loadMeasuredReviewResult } from "@gate/types";
import { describe, expect, it } from "vitest";
import { parseEngineResult, SCHEMA_VERSION } from "../src/index.js";

/**
 * The single highest-risk line item in the measurement work.
 *
 * `GateReviewResultSchema` is deliberately NOT `.strict()`, so additive engine
 * fields are tolerated by an older Gate. The cost of that design is that a field
 * this schema does not NAME is stripped: silently, with no error and no log
 * line. Everything else in this change could ship correctly and the pull-request
 * surface would still show nothing, while `judgment.ts` kept publishing "the
 * capture and the measured facts are real" over a payload that had none.
 *
 * So the contract is pinned here from both directions: a new engine's field
 * survives, and an old engine's silence still parses.
 */

const golden = loadGoldenReviewResult();
const measured = loadMeasuredReviewResult();

describe("measurements survive the engine contract parser", () => {
  it("keeps the whole report rather than stripping it", () => {
    const out = parseEngineResult(measured, SCHEMA_VERSION);

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.measurements?.checksRun).toEqual(["contrast", "overflow", "touch_target"]);
    expect(out.result.measurements?.violations).toHaveLength(3);
    const [first] = out.result.measurements?.violations ?? [];
    expect(first?.element).toBe("#hero-subtitle");
    expect(first?.detail).toBe("text contrast 3.23:1 is below WCAG AA 4.5:1");
    expect(first?.viewports).toEqual(["mobile", "desktop"]);
    expect(first?.blockEligible).toBe(true);
  });

  it("preserves an engine's `false` precision flag rather than defaulting it", () => {
    // Gate never computes `blockEligible` and never overrides it. A `false`
    // that arrived as `true` would let a repo block a merge on a measurement the
    // engine had explicitly declined to stand behind.
    const out = parseEngineResult(measured, SCHEMA_VERSION);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.measurements?.violations.map((v) => v.blockEligible)).toEqual([
      true,
      false,
      false,
    ]);
  });
});

describe("mixed versions, both directions", () => {
  it("an OLD engine that sends no measurements still parses", () => {
    const out = parseEngineResult(golden, SCHEMA_VERSION);

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // Absent, not empty: "this producer does not report measurements", which no
    // consumer may read as "the page is clean".
    expect(out.result).not.toHaveProperty("measurements");
  });

  it("a NEWER engine that adds a field inside a violation is tolerated, not rejected", () => {
    // The non-strict rule applies inside the object too: an engine that starts
    // reporting, say, a measured pixel value must not turn an honest result into
    // a parse failure and a blocked publish.
    const forward = {
      ...measured,
      measurements: {
        ...measured.measurements,
        violations: (measured.measurements?.violations ?? []).map((violation) => ({
          ...violation,
          measuredPx: 3.23,
        })),
      },
    };
    const out = parseEngineResult(forward, SCHEMA_VERSION);

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.measurements?.violations).toHaveLength(3);
  });

  it("a NEWER engine that adds a check kind is rejected rather than guessed", () => {
    // The kinds are a closed enum on both sides. A kind Gate cannot render is
    // not something to display as an unlabelled row; the parse failure is a
    // typed contract error that says which majors disagree.
    const out = parseEngineResult(
      {
        ...measured,
        measurements: {
          checksRun: ["contrast", "reflow"],
          violations: measured.measurements?.violations ?? [],
        },
      },
      SCHEMA_VERSION,
    );

    expect(out.ok).toBe(false);
  });

  it("a half-stated report is rejected: violations without checksRun cannot be read", () => {
    // `violations: []` with no `checksRun` cannot tell "measured, clean" from
    // "not measured". Half-stated is not a weaker claim, it is an unreadable
    // one, and omitting the object entirely is the supported way to say nothing.
    const out = parseEngineResult(
      { ...measured, measurements: { violations: [] } },
      SCHEMA_VERSION,
    );

    expect(out.ok).toBe(false);
  });

  it("a new gradeUnavailableReason needs no parser change at all", () => {
    // The field is `z.string().min(1).optional()` and documented as open, which
    // is why the retraction ships against already-deployed gates.
    const out = parseEngineResult(
      { ...golden, gradeUnavailableReason: "measured_facts_unjudged" },
      SCHEMA_VERSION,
    );

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.gradeUnavailableReason).toBe("measured_facts_unjudged");
  });
});
