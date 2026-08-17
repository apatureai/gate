import { loadGoldenReviewResult, type GateReviewResult, type Measurement } from "@gate/types";
import { describe, expect, it } from "vitest";
import {
  baselineSection,
  buildCheckRun,
  buildMeasurementBaseline,
  compareMeasurementsToBaseline,
  type MeasurementComparison,
} from "../src/index.js";

/**
 * WHO GETS THE CLAIM, AND WHAT AN ENGINE UPGRADE DOES TO IT.
 *
 * Two failures found by mutating the baseline comparison, both of which end in
 * the same place: a red check on a pull request that changed no colour.
 *
 * The first is an ordering bug with a nasty shape. Baseline entries sharing a
 * defect key are interchangeable, so when more violations want one than exist,
 * whoever is served last is called introduced. Serving the engine's order let a
 * violation MUTED by `rules.measurement_suppress` take the entry an innocent
 * refactored violation needed. The muted one is rendered by nothing; the
 * innocent one turned the check red. A repository's only escape hatch from a
 * false red check was a way of manufacturing one.
 *
 * The second is an engine upgrade. The detail is the ENGINE's sentence, and the
 * engine can reword it while the page holds still. A reword alone is absorbed by
 * the element key. A reword on a violation whose markup ALSO moved misses the
 * fingerprint, the element key and the defect key at once, and an untouched
 * defect reads as introduced. `engineVersion` was recorded on every snapshot and
 * never compared, so nothing stopped it.
 *
 * The tests below pin the fixes and, as much as anything, pin the COSTS: a muted
 * violation still spends its entry, an engine skew does not switch gating off
 * wholesale, and an unknown engine version is not treated as skew.
 */

const DETAIL = "text contrast 2.91:1 is below WCAG AA 4.5:1";
const ENGINE_THEN = "gate-engine/1.4.0";
const ENGINE_NOW = "gate-engine/1.5.0";

/** The violation every case here refactors, on the site root. */
const TAGLINE: Measurement = {
  kind: "contrast",
  route: "/",
  viewports: ["mobile"],
  element: "#hero .tagline",
  detail: DETAIL,
  blockEligible: true,
};

/** A second violation with the SAME defect key, on the same page. */
const PROMO: Measurement = { ...TAGLINE, element: "#promo .tagline" };

const ROUTES = ["/", "/pricing"];

function runOf(violations: Measurement[], engineVersion = ENGINE_NOW): GateReviewResult {
  const golden = loadGoldenReviewResult();
  return {
    ...golden,
    metadata: { ...golden.metadata, engineVersion },
    measurements: { checksRun: ["contrast", "overflow", "touch_target"], violations },
    coverage: {
      routesRequested: ROUTES,
      routesReviewed: ROUTES,
      viewportsRequested: ["mobile"],
      viewportsReviewed: ["mobile"],
    },
  };
}

function baselineOf(violations: Measurement[], engineVersion: string | null = ENGINE_NOW) {
  const snapshot = buildMeasurementBaseline(runOf(violations, engineVersion ?? ENGINE_NOW), {
    commitSha: "basesha0000",
  });
  return { ...snapshot, engineVersion };
}

function compare(
  violations: Measurement[],
  options: { baseline?: ReturnType<typeof baselineOf>; suppress?: string[]; engineVersion?: string } = {},
): MeasurementComparison {
  return compareMeasurementsToBaseline(runOf(violations, options.engineVersion ?? ENGINE_NOW), {
    lookup: { status: "found", snapshot: options.baseline ?? baselineOf([TAGLINE]) },
    ...(options.suppress ? { suppress: options.suppress } : {}),
  });
}

/** Whether `rules.measurements: block` would fail the check on this comparison. */
function blocks(
  comparison: MeasurementComparison,
  violations: Measurement[],
  suppress?: string[],
): boolean {
  return (
    buildCheckRun(runOf(violations), "none", {
      measurements: "block",
      baseline: comparison,
      ...(suppress ? { suppress } : {}),
    }).conclusion === "failure"
  );
}

describe("a muted violation must not take the entry a visible one needed", () => {
  // The muted violation is listed FIRST on purpose. Engine order is what the
  // comparison used to follow, so a fix that only happens to work when the
  // visible violation comes first would pass a weaker version of this test.
  const MUTED_NEW: Measurement = { ...TAGLINE, element: ".promo-banner .cta" };
  const REFACTORED: Measurement = { ...TAGLINE, element: "#hero .inner .tagline" };
  const SUPPRESS = ["contrast:.promo-banner .cta"];

  it("leaves the refactored violation pre-existing rather than introduced", () => {
    const violations = [MUTED_NEW, REFACTORED];
    const comparison = compare(violations, { suppress: SUPPRESS });

    expect(comparison.introduced).toEqual([]);
    expect(comparison.preExisting).toEqual([REFACTORED]);
    expect(comparison.classified.find((row) => row.measurement === REFACTORED)?.elementChanged).toBe(
      true,
    );
  });

  it("does not fail the check under block", () => {
    // The whole point. Suppressing a violation may not turn a green check red on
    // a pull request that only moved some markup.
    const violations = [MUTED_NEW, REFACTORED];
    expect(blocks(compare(violations, { suppress: SUPPRESS }), violations, SUPPRESS)).toBe(false);
  });

  it("renders nothing about the muted one either way", () => {
    const violations = [MUTED_NEW, REFACTORED];
    const section = baselineSection(compare(violations, { suppress: SUPPRESS }), {
      mode: "block",
    });

    expect(section).not.toContain("promo-banner");
  });
});

describe("a muted violation still spends its entry", () => {
  // The other half of the same rule, and the one that keeps the fix above from
  // becoming a lie in the flattering direction. Muting hides a violation; it
  // does not fix it, and a spent entry is one that cannot be counted as gone.
  const VISIBLE = { ...TAGLINE, element: "#hero .inner .tagline" };
  const MUTED = { ...PROMO, element: "#promo .inner .tagline" };
  const SUPPRESS = ["contrast:#promo .inner .tagline"];

  it("does not let a mute read as a fix", () => {
    const comparison = compare([VISIBLE, MUTED], {
      baseline: baselineOf([TAGLINE, PROMO]),
      suppress: SUPPRESS,
    });

    expect(comparison.preExisting).toEqual([VISIBLE]);
    // Both baseline entries are accounted for: one by the visible refactor, one
    // by the muted one. Skipping muted violations here would report the muted
    // half of the page as repaired.
    expect(comparison.resolved).toBe(0);
  });

  it("counts a genuinely repaired violation as resolved for comparison", () => {
    // The control for the assertion above: with nothing muted and nothing
    // carrying the second entry, `resolved` really does move.
    const comparison = compare([VISIBLE], { baseline: baselineOf([TAGLINE, PROMO]) });

    expect(comparison.resolved).toBe(1);
  });
});

describe("one stored violation answers for one violation here", () => {
  // The second key used to be MATCHED rather than spent, so a single stored
  // entry could absolve every violation on its element. An element that was
  // merely low-contrast and now carries a second, worse failure read as
  // unchanged, and `block` never saw a regression on markup that already had a
  // defect of the same check.
  //
  // A SECOND DEFECT, not the same one measured worse. Magnitudes are stripped
  // from every key on purpose, so "contrast 2.91:1" and "contrast 1.02:1" on one
  // element are one violation whose measurement moved, and neither key nor
  // budget separates them. What this describes is an element that carries a
  // second, differently stated failure of the same check.
  const WORSE: Measurement = {
    ...TAGLINE,
    detail: "text is placed over a background image with no contrast floor",
  };

  it("calls the second defect on an element introduced", () => {
    const comparison = compare([TAGLINE, WORSE]);

    expect(comparison.preExisting).toEqual([TAGLINE]);
    expect(comparison.introduced).toEqual([WORSE]);
  });

  it("fails the check under block", () => {
    expect(blocks(compare([TAGLINE, WORSE]), [TAGLINE, WORSE])).toBe(true);
  });

  it("still carries both over when the base recorded both", () => {
    // The control. Two entries, two violations, nothing new: the budget is only
    // interesting when it runs out.
    const comparison = compare([TAGLINE, WORSE], { baseline: baselineOf([TAGLINE, WORSE]) });

    expect(comparison.introduced).toEqual([]);
    expect(comparison.preExisting).toHaveLength(2);
    expect(comparison.resolved).toBe(0);
  });

  it("matches the strongest key first, whatever order the engine reported", () => {
    // WORSE is listed first here. If violations were placed one at a time
    // through every tier, it would reach the element key and spend the entry
    // that TAGLINE matches EXACTLY, and the exact match would then be called
    // introduced. Which violation is carried over would depend on the engine's
    // ordering rather than on the evidence.
    const comparison = compare([WORSE, TAGLINE]);

    expect(comparison.preExisting).toEqual([TAGLINE]);
    expect(comparison.introduced).toEqual([WORSE]);
  });
});

describe("an engine upgrade may split one row into two without gating", () => {
  // The exception to the budget above, and the reason it is an exception. A new
  // engine can report as two rows what the old one reported as one, and
  // budgeting that would call the second row new on a page nobody edited. Under
  // ONE engine a second row is a second defect, because the wording cannot have
  // moved on its own.
  const SPLIT_A: Measurement = { ...TAGLINE, detail: "foreground contrast is under the AA minimum" };
  const SPLIT_B: Measurement = { ...TAGLINE, detail: "placeholder contrast is under the AA minimum" };
  const BASE = baselineOf([TAGLINE], ENGINE_THEN);

  it("carries both rows over", () => {
    const comparison = compare([SPLIT_A, SPLIT_B], { baseline: BASE });

    expect(comparison.introduced).toEqual([]);
    expect(comparison.preExisting).toEqual([SPLIT_A, SPLIT_B]);
  });

  it("does not also report the violation as gone", () => {
    // A violation Gate just called pre-existing must never be counted among the
    // ones that are fixed, and the lenient match leaves its entry unspent.
    expect(compare([SPLIT_A, SPLIT_B], { baseline: BASE }).resolved).toBe(0);
  });

  it("is not extended to a run on the same engine", () => {
    const comparison = compare([SPLIT_A, SPLIT_B], { baseline: baselineOf([TAGLINE]) });

    expect(comparison.introduced).toEqual([SPLIT_B]);
  });
});

describe("an engine that reworded itself must not manufacture a merge blocker", () => {
  // A wrapper div AND a reworded sentence on the same violation, which is the
  // one combination that misses every key at once.
  const MOVED_AND_REWORDED: Measurement = {
    ...TAGLINE,
    element: "#hero .inner .tagline",
    detail: "contrast is under the WCAG AA minimum",
  };
  const BASE = baselineOf([TAGLINE], ENGINE_THEN);

  it("reports it as unclassified rather than new", () => {
    const comparison = compare([MOVED_AND_REWORDED], { baseline: BASE });

    expect(comparison.introduced).toEqual([]);
    expect(comparison.unclassified).toEqual([MOVED_AND_REWORDED]);
    expect(comparison.classified[0]?.reason).toBe("engine_skew");
    // Not pre-existing either. Nothing here shows it is the same violation, and
    // saying so would be a claim Gate cannot support.
    expect(comparison.preExisting).toEqual([]);
  });

  it("does not fail the check under block", () => {
    expect(blocks(compare([MOVED_AND_REWORDED], { baseline: BASE }), [MOVED_AND_REWORDED])).toBe(
      false,
    );
  });

  it("says which two engines produced the two runs", () => {
    const section = baselineSection(compare([MOVED_AND_REWORDED], { baseline: BASE }), {
      mode: "block",
    });

    expect(section).toContain(ENGINE_THEN);
    expect(section).toContain(ENGINE_NOW);
    expect(section).toMatch(/not classified|not being called pre-existing/i);
  });

  it("does not print the engine note when both runs are the same engine", () => {
    // A run that quietly used a weaker rule and a run that used the normal one
    // must not render the same page.
    const section = baselineSection(compare([TAGLINE], { baseline: baselineOf([TAGLINE]) }), {
      mode: "block",
    });

    expect(section ?? "").not.toContain("recorded by engine");
  });
});

describe("what engine skew does NOT do", () => {
  const BASE = baselineOf([TAGLINE], ENGINE_THEN);
  const NEW_BANNER: Measurement = {
    kind: "contrast",
    route: "/pricing",
    viewports: ["mobile"],
    element: "#banner .cta",
    detail: "text contrast 2.10:1 is below WCAG AA 4.5:1",
    blockEligible: true,
  };

  it("still gates a new violation on a page where nothing went missing", () => {
    // The old violation is still here, untouched, so no entry is unaccounted
    // for and the weaker rule has nothing to offer. Skew must not be a blanket
    // amnesty: that would turn every engine release into a silent gap.
    const violations = [TAGLINE, NEW_BANNER];
    const comparison = compare(violations, { baseline: BASE });

    expect(comparison.introduced).toEqual([NEW_BANNER]);
    expect(blocks(comparison, violations)).toBe(true);
  });

  it("does not let two new violations shelter behind one that vanished", () => {
    // One entry went missing, so exactly one violation may be excused by it.
    // The second is introduced and gates, which is the budget that keeps this
    // tier from being an identity.
    const first: Measurement = { ...TAGLINE, element: "#a .x", detail: "contrast is too low here" };
    const second: Measurement = { ...TAGLINE, element: "#b .y", detail: "contrast is too weak now" };
    const comparison = compare([first, second], { baseline: BASE });

    expect(comparison.unclassified).toHaveLength(1);
    expect(comparison.introduced).toHaveLength(1);
    expect(blocks(comparison, [first, second])).toBe(true);
  });

  it("is not inferred from a baseline that never recorded an engine version", () => {
    // Gate cannot show two engines differ from a missing field, and reading the
    // gap as skew would weaken every comparison on a path that does not record
    // one. The strict rule stays, and the residual cost stays with it.
    const moved = { ...TAGLINE, element: "#hero .inner .tagline", detail: "contrast is too low" };
    const comparison = compare([moved], { baseline: baselineOf([TAGLINE], null) });

    expect(comparison.engineSkew).toBeUndefined();
    expect(comparison.introduced).toEqual([moved]);
  });
});
