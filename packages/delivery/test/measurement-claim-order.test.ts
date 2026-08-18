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

describe("a page compared against itself is never a regression", () => {
  /**
   * The pairing bug this pins was invisible until entries carried a band.
   *
   * Entries under one key are recorded in the base run's order, and this run's
   * violations arrive in the same engine's order. Taking entries from the BACK
   * paired the two runs in reverse, so a page whose colour token differs
   * between two viewports had its bands swapped and read as one violation
   * improved plus one made worse. On an empty pull request that is a red check,
   * and every test passed either way because nothing else in a stored entry
   * depends on which of two identical-identity entries a violation claims.
   *
   * A run compared against a baseline built from itself is the whole invariant
   * in one line: whatever the pairing, it cannot produce a change.
   */
  const identical = (severities: number[]): Measurement[] =>
    severities.map((severity) => ({ ...TAGLINE, severity }));

  it("reports no regression when the run and the base are the same run", () => {
    // Two violations sharing an identity and differing only in band, which is
    // exactly what one element measured at two viewports produces.
    const violations = identical([1, 2]);
    const comparison = compare(violations, { baseline: baselineOf(violations) });

    expect(comparison.worsened).toEqual([]);
    expect(comparison.introduced).toEqual([]);
    expect(comparison.preExisting).toHaveLength(2);
    expect(blocks(comparison, violations)).toBe(false);
  });

  it("holds whichever order the engine reported the two in", () => {
    const violations = identical([2, 1]);
    const comparison = compare(violations, { baseline: baselineOf(identical([1, 2])) });

    expect(comparison.worsened).toEqual([]);
    expect(blocks(comparison, violations)).toBe(false);
  });

  it("still catches a band that really did move", () => {
    // The control. If the assertions above passed because nothing is compared
    // at all, this one fails.
    const violations = identical([1, 3]);
    const comparison = compare(violations, { baseline: baselineOf(identical([1, 2])) });

    expect(comparison.worsened).toHaveLength(1);
    expect(blocks(comparison, violations)).toBe(true);
  });
});

describe("a band is only comparable across the same viewports", () => {
  /**
   * A band is the worst measurement across the viewports a run looked at, and
   * identity excludes the viewport deliberately. So widening `viewports:` in
   * the repository config measures the same markup somewhere the base run never
   * visited, the worst band rises, and byte-identical HTML reads as a regression
   * this pull request caused. A config edit must not fail a build.
   */
  const mobileOnly = (violations: Measurement[]): GateReviewResult => ({
    ...runOf(violations),
    coverage: {
      routesRequested: ROUTES,
      routesReviewed: ROUTES,
      viewportsRequested: ["mobile"],
      viewportsReviewed: ["mobile"],
    },
  });
  const alsoDesktop = (violations: Measurement[]): GateReviewResult => ({
    ...runOf(violations),
    coverage: {
      routesRequested: ROUTES,
      routesReviewed: ROUTES,
      viewportsRequested: ["mobile", "desktop"],
      viewportsReviewed: ["mobile", "desktop"],
    },
  });

  it("does not call a widened viewport set a regression", () => {
    const base = buildMeasurementBaseline(mobileOnly([{ ...TAGLINE, severity: 1 }]), {
      commitSha: "basesha0000",
    });
    const now = alsoDesktop([{ ...TAGLINE, viewports: ["mobile", "desktop"], severity: 3 }]);
    const comparison = compareMeasurementsToBaseline(now, {
      lookup: { status: "found", snapshot: base },
    });

    expect(comparison.preExisting).toHaveLength(1);
    expect(comparison.worsened).toEqual([]);
  });

  it("still compares when the run measured the same viewports or fewer", () => {
    // The control. Narrowing is safe: a band that fell because nobody looked is
    // not a fix, and a band that rose on viewports the base also measured is a
    // real comparison.
    const base = buildMeasurementBaseline(alsoDesktop([{ ...TAGLINE, severity: 1 }]), {
      commitSha: "basesha0000",
    });
    const comparison = compareMeasurementsToBaseline(alsoDesktop([{ ...TAGLINE, severity: 3 }]), {
      lookup: { status: "found", snapshot: base },
    });

    expect(comparison.worsened).toHaveLength(1);
  });

  it("still compares bands when the snapshot records no viewport list of its own", () => {
    // A run-wide switch used to live here and discard EVERY band comparison the
    // moment this run touched a viewport the base did not. One new viewport
    // anywhere silenced regression detection on every route and every check,
    // which is a worse failure than the false red it was added to prevent. The
    // snapshot-level list now feeds only the unseen-viewport screen; the bands
    // are placed from the viewports on the stored rows themselves.
    const base = buildMeasurementBaseline(runOf([{ ...TAGLINE, severity: 1 }]), {
      commitSha: "basesha0000",
    });
    const { viewportsMeasured: _dropped, ...older } = base;
    const worse = { ...TAGLINE, severity: 3 };
    const comparison = compareMeasurementsToBaseline(runOf([worse]), {
      lookup: { status: "found", snapshot: older },
    });

    expect(comparison.worsened).toEqual([worse]);
  });
});

describe("an overflow that deepened is reported and never gates", () => {
  // Overflow bands are cut at 10% and 50% of the viewport, which are Gate's own
  // proportions rather than a published standard, and one pixel of body padding
  // can cross one. Contrast and touch-target landmarks are WCAG's own, so a
  // change that crosses those is material by a definition nobody here invented.
  const WIDE: Measurement = {
    kind: "overflow",
    route: "/",
    viewports: ["mobile"],
    element: "#plans .grid",
    detail: "element is 412px wide inside a 390px viewport",
    blockEligible: true,
    severity: 1,
  };
  const WIDER: Measurement = { ...WIDE, severity: 3 };

  it("marks it worsened", () => {
    const comparison = compare([WIDER], { baseline: baselineOf([WIDE]) });

    expect(comparison.worsened).toEqual([WIDER]);
  });

  it("does not fail the check on it", () => {
    expect(blocks(compare([WIDER], { baseline: baselineOf([WIDE]) }), [WIDER])).toBe(false);
  });

  it("still fails on a contrast band that moved the same distance", () => {
    // The control that keeps the exclusion from quietly becoming a blanket one.
    const worse = { ...TAGLINE, severity: 3 };
    const comparison = compare([worse], { baseline: baselineOf([{ ...TAGLINE, severity: 1 }]) });

    expect(blocks(comparison, [worse])).toBe(true);
  });

  it("still fails on an overflow this pull request introduced", () => {
    // The exclusion is about a band moving, not about the check.
    const fresh = { ...WIDE, element: "#new .grid" };
    const comparison = compare([fresh], { baseline: baselineOf([]) });

    expect(comparison.introduced).toEqual([fresh]);
    expect(blocks(comparison, [fresh])).toBe(true);
  });
});

describe("the surfaces keep worse apart from new", () => {
  // Both of these survived an auditor's mutation with the whole suite green.
  const worse = { ...TAGLINE, severity: 3 };
  const worsened = () => compare([worse], { baseline: baselineOf([{ ...TAGLINE, severity: 1 }]) });

  it("names a worsened violation as already present rather than introduced", () => {
    const section = baselineSection(worsened(), { mode: "block", blocking: true }) ?? "";

    expect(section).toMatch(/worse/i);
    expect(section).not.toMatch(/New in this pull request/);
  });

  it("takes the worst recorded band under engine skew, not the best", () => {
    // Under skew the element tier is matched rather than spent, so several
    // stored rows can answer for one violation. Taking the best of them would
    // report a regression against a row that was never the worst thing there.
    const base = baselineOf(
      [
        { ...TAGLINE, severity: 1 },
        { ...TAGLINE, severity: 3 },
      ],
      ENGINE_THEN,
    );
    const comparison = compare([{ ...TAGLINE, severity: 3 }], { baseline: base });

    expect(comparison.worsened).toEqual([]);
  });
});

describe("a widened viewports config is not a pull request's fault", () => {
  /**
   * The false red check that survived the first fix, reached through a door the
   * fix did not cover. Guarding only the BAND comparison left the entry budget
   * alone: an element behind a media query emits one row per viewport, so adding
   * `tablet` adds a row sharing the identity, the baseline has no spare entry
   * for it, and it was called introduced. Byte-identical HTML, red check.
   */
  const at = (viewports: Measurement["viewports"], severity: number): Measurement => ({
    ...TAGLINE,
    viewports,
    severity,
  });
  const baseRun = (violations: Measurement[]): GateReviewResult => ({
    ...runOf(violations),
    coverage: {
      routesRequested: ROUTES,
      routesReviewed: ROUTES,
      viewportsRequested: ["mobile", "desktop"],
      viewportsReviewed: ["mobile", "desktop"],
    },
  });
  const widened = (violations: Measurement[]): GateReviewResult => ({
    ...runOf(violations),
    coverage: {
      routesRequested: ROUTES,
      routesReviewed: ROUTES,
      viewportsRequested: ["mobile", "desktop", "tablet"],
      viewportsReviewed: ["mobile", "desktop", "tablet"],
    },
  });
  const base = buildMeasurementBaseline(baseRun([at(["mobile"], 2), at(["desktop"], 1)]), {
    commitSha: "basesha0000",
  });

  it("does not call the new viewport's row introduced", () => {
    const now = widened([at(["mobile"], 2), at(["desktop"], 1), at(["tablet"], 1)]);
    const comparison = compareMeasurementsToBaseline(now, {
      lookup: { status: "found", snapshot: base },
    });

    expect(comparison.introduced).toEqual([]);
    expect(comparison.unclassified).toHaveLength(1);
    expect(comparison.classified.at(-1)?.reason).toBe("viewport_not_measured");
  });

  it("does not fail the check on it", () => {
    const violations = [at(["mobile"], 2), at(["desktop"], 1), at(["tablet"], 1)];
    const comparison = compareMeasurementsToBaseline(widened(violations), {
      lookup: { status: "found", snapshot: base },
    });

    expect(
      buildCheckRun(widened(violations), "none", {
        measurements: "block",
        baseline: comparison,
      }).conclusion,
    ).not.toBe("failure");
  });

  it("still calls a violation new when the base did measure that viewport", () => {
    // The control. The screen is about a viewport nobody looked at, not about
    // viewports in general, and a genuinely new row at a measured viewport must
    // still gate.
    const fresh = { ...at(["mobile"], 2), element: "#brand-new .cta" };
    const violations = [at(["mobile"], 2), at(["desktop"], 1), fresh];
    const comparison = compareMeasurementsToBaseline(baseRun(violations), {
      lookup: { status: "found", snapshot: base },
    });

    expect(comparison.introduced).toEqual([fresh]);
  });

  it("still answers for a row seen at both an old viewport and a new one", () => {
    // Measured where the base looked AND where it did not: the base can speak
    // to it, so it is placed rather than excused.
    const both = at(["mobile", "tablet"], 2);
    const comparison = compareMeasurementsToBaseline(widened([both, at(["desktop"], 1)]), {
      lookup: { status: "found", snapshot: base },
    });

    expect(comparison.unclassified).toEqual([]);
    expect(comparison.preExisting).toContain(both);
  });
});

describe("a band is compared against the viewport it was measured at", () => {
  /**
   * A regression crossing WCAG's own landmark passed silently. Taking the worst
   * band across the whole identity let a mobile row that was already band 3 hide
   * a desktop row falling from 3.40:1 to 1.02:1, which is band 1 to band 3 on the
   * only rendering that changed.
   */
  const at = (viewports: Measurement["viewports"], severity: number): Measurement => ({
    ...TAGLINE,
    viewports,
    severity,
  });
  const twoViewports = (violations: Measurement[]): GateReviewResult => ({
    ...runOf(violations),
    coverage: {
      routesRequested: ROUTES,
      routesReviewed: ROUTES,
      viewportsRequested: ["mobile", "desktop"],
      viewportsReviewed: ["mobile", "desktop"],
    },
  });
  const base = buildMeasurementBaseline(twoViewports([at(["mobile"], 3), at(["desktop"], 1)]), {
    commitSha: "basesha0000",
  });

  it("catches a desktop regression that a worse mobile row used to hide", () => {
    const worse = at(["desktop"], 3);
    const comparison = compareMeasurementsToBaseline(twoViewports([at(["mobile"], 3), worse]), {
      lookup: { status: "found", snapshot: base },
    });

    expect(comparison.worsened).toEqual([worse]);
    expect(
      buildCheckRun(twoViewports([at(["mobile"], 3), worse]), "none", {
        measurements: "block",
        baseline: comparison,
      }).conclusion,
    ).toBe("failure");
  });

  it("does not call the unchanged viewport worsened", () => {
    const comparison = compareMeasurementsToBaseline(
      twoViewports([at(["mobile"], 3), at(["desktop"], 1)]),
      { lookup: { status: "found", snapshot: base } },
    );

    expect(comparison.worsened).toEqual([]);
  });

  it("falls back to the whole identity when a stored row has no viewports", () => {
    // A baseline written before entries carried viewports cannot be placed at
    // one, and the group rule is what this did before the field existed.
    const legacy = {
      ...base,
      entries: base.entries.map(({ viewports: _drop, ...entry }) => entry),
    };
    const comparison = compareMeasurementsToBaseline(
      twoViewports([at(["mobile"], 3), at(["desktop"], 3)]),
      { lookup: { status: "found", snapshot: legacy } },
    );

    expect(comparison.worsened).toEqual([]);
  });
});

describe("the block-mode surfaces agree with themselves", () => {
  const at = (kind: Measurement["kind"], severity: number): Measurement => ({
    ...TAGLINE,
    kind,
    element: kind === "overflow" ? "#plans .grid" : "#hero .tagline",
    detail: kind === "overflow" ? "element is 412px wide inside a 390px viewport" : DETAIL,
    severity,
  });

  it("names the overflow exclusion on the run where it decided the outcome", () => {
    // A green run that prints a row satisfying every condition the closing
    // sentence lists is an explanation contradicting its own evidence, and a
    // reader concludes the check is broken.
    const violations = [at("overflow", 3)];
    const comparison = compare(violations, { baseline: baselineOf([at("overflow", 1)]) });
    const section = baselineSection(comparison, { mode: "block" }) ?? "";

    expect(comparison.worsened).toHaveLength(1);
    expect(section).toContain("`overflow`");
    expect(section).toMatch(/never fails a check/i);
  });

  it("splits the failing count into parts that add up to it", () => {
    // The count came from the gating set and the split came from the comparison,
    // so a deepened overflow beside an introduced contrast violation published
    // "1 measurement ... 1 of them is new here and 1 was already on the base".
    const fresh = { ...at("contrast", 1), element: "#brand-new .cta" };
    const violations = [fresh, at("overflow", 3)];
    const comparison = compare(violations, { baseline: baselineOf([at("overflow", 1)]) });
    const summary = buildCheckRun(runOf(violations), "none", {
      measurements: "block",
      baseline: comparison,
    }).summary;

    expect(summary).toContain("1 block-eligible measurement(s)");
    expect(summary).not.toMatch(/1 of them is new here and 1 /);
  });

  it("keeps the made-worse heading distinct from the introduced one", () => {
    // Retitling this heading passed the whole suite: nothing asserted the
    // string, and a worsened violation rendered as new while the counts line
    // still said zero were introduced.
    const worse = { ...TAGLINE, severity: 3 };
    const comparison = compare([worse], { baseline: baselineOf([{ ...TAGLINE, severity: 1 }]) });
    const section = baselineSection(comparison, { mode: "block", blocking: true }) ?? "";

    expect(section).toContain("**Made worse by this pull request**");
    expect(section).not.toContain("**Introduced by this pull request**");
  });
});

describe("an unplaceable band and a partly unseen row", () => {
  /**
   * Two guards that survived mutation with the whole suite green, both of them
   * one character wide and both of them a wrong answer in a different direction.
   */
  const at = (viewports: Measurement["viewports"], severity: number, over: Partial<Measurement> = {}): Measurement => ({
    ...TAGLINE,
    viewports,
    severity,
    ...over,
  });
  const covering = (
    violations: Measurement[],
    viewportsReviewed: GateReviewResult["coverage"]["viewportsReviewed"],
  ): GateReviewResult => ({
    ...runOf(violations),
    coverage: {
      routesRequested: ROUTES,
      routesReviewed: ROUTES,
      viewportsRequested: viewportsReviewed,
      viewportsReviewed,
    },
  });
  const base = buildMeasurementBaseline(covering([at(["mobile"], 1)], ["mobile", "desktop"]), {
    commitSha: "basesha0000",
  });

  it("calls a violation new when the base measured that viewport and recorded nothing", () => {
    // The violation matches a stored row exactly, so it is carried over, but
    // every stored row of that identity was measured somewhere else. There is
    // no band to compare against. Reading that as band zero would make any
    // stated band look like a regression, which is the "absent means the best
    // there is" mistake in a new place.
    // Narrowed rather than widened, so the viewport-subset guard does NOT
    // short-circuit first and this line is the one under test: the base looked
    // at mobile and desktop, this run looked only at desktop, and the one
    // stored row of this identity was measured at mobile.
    const now = at(["desktop"], 3);
    const comparison = compareMeasurementsToBaseline(covering([now], ["desktop"]), {
      lookup: { status: "found", snapshot: base },
    });

    // The stored row of this identity was measured at mobile, and a claim may
    // not reach across viewports: letting it made the leftover row, byte for
    // byte what the base recorded, read as the new one. The base looked at
    // desktop and recorded nothing there, so a desktop violation is genuinely
    // new and no band question arises.
    expect(comparison.introduced).toEqual([now]);
    expect(comparison.worsened).toEqual([]);
    expect(comparison.classified[0]?.baselineSeverity).toBeUndefined();
  });

  it("still calls a new row introduced when it was also seen where the base looked", () => {
    // The unseen-viewport screen excuses a row measured ONLY where the base
    // never looked. A row seen at a measured viewport too is answerable there,
    // and excusing it would let a genuinely new violation through by adding a
    // viewport to the config.
    const fresh = at(["desktop", "tablet"], 2, { element: "#brand-new .cta" });
    const comparison = compareMeasurementsToBaseline(
      covering([at(["mobile"], 1), fresh], ["mobile", "desktop", "tablet"]),
      { lookup: { status: "found", snapshot: base } },
    );

    expect(comparison.introduced).toEqual([fresh]);
    expect(comparison.unclassified).toEqual([]);
  });
});

describe("one new viewport does not switch regression detection off", () => {
  /**
   * The worst thing either fix could have done, and it did it. A run-wide
   * `bandsComparable` flag discarded every band comparison whenever this run
   * measured any viewport the base did not, so widening `viewports:` or simply
   * losing a capture on the base run silenced worsening detection for the whole
   * run. The check went green and its closing sentence still promised that a
   * violation moved into a worse band would have failed it.
   */
  const at = (viewports: Measurement["viewports"], severity: number, over: Partial<Measurement> = {}): Measurement => ({
    ...TAGLINE,
    viewports,
    severity,
    ...over,
  });
  const covering = (
    violations: Measurement[],
    viewportsReviewed: GateReviewResult["coverage"]["viewportsReviewed"],
  ): GateReviewResult => ({
    ...runOf(violations),
    coverage: {
      routesRequested: ROUTES,
      routesReviewed: ROUTES,
      viewportsRequested: viewportsReviewed,
      viewportsReviewed,
    },
  });
  const base = buildMeasurementBaseline(covering([at(["desktop"], 1)], ["desktop"]), {
    commitSha: "basesha0000",
  });

  it("still catches a desktop regression on a run that also added a breakpoint", () => {
    const worse = at(["desktop"], 3);
    const now = covering([worse], ["desktop", "tablet"]);
    const comparison = compareMeasurementsToBaseline(now, {
      lookup: { status: "found", snapshot: base },
    });

    expect(comparison.worsened).toEqual([worse]);
    expect(
      buildCheckRun(now, "none", { measurements: "block", baseline: comparison }).conclusion,
    ).toBe("failure");
  });

  it("still catches it when the base run simply lost a capture", () => {
    // Not a config edit at all. The base measured desktop, this run got desktop
    // and mobile, and the desktop regression is still answerable against desktop.
    const worse = at(["desktop"], 3);
    const now = covering([worse, at(["mobile"], 1, { element: "#other .x" })], ["desktop", "mobile"]);
    const comparison = compareMeasurementsToBaseline(now, {
      lookup: { status: "found", snapshot: base },
    });

    expect(comparison.worsened).toEqual([worse]);
  });

  it("does not compare a row spanning a viewport the base never measured", () => {
    // The other side of the same rule. A band is the worst across the viewports
    // its row covers, so a row covering desktop AND tablet against a stored row
    // that only saw desktop compares two different aggregates: the band may have
    // risen because tablet is worse, and nobody measured tablet before.
    const spanning = at(["desktop", "tablet"], 3);
    const comparison = compareMeasurementsToBaseline(
      covering([spanning], ["desktop", "tablet"]),
      { lookup: { status: "found", snapshot: base } },
    );

    expect(comparison.worsened).toEqual([]);
    expect(comparison.preExisting).toEqual([spanning]);
  });
});

describe("a violation Gate could not place is said out loud", () => {
  // A pull request that adds a breakpoint and a violation only visible at it
  // gates nothing, correctly: the base never looked there. The risk is the
  // sentence beside it, which reads as a clean bill of health to anyone who does
  // not weigh the "could place" qualifier.
  const at = (viewports: Measurement["viewports"], over: Partial<Measurement> = {}): Measurement => ({
    ...TAGLINE,
    viewports,
    severity: 2,
    ...over,
  });
  const covering = (
    violations: Measurement[],
    viewportsReviewed: GateReviewResult["coverage"]["viewportsReviewed"],
  ): GateReviewResult => ({
    ...runOf(violations),
    coverage: {
      routesRequested: ROUTES,
      routesReviewed: ROUTES,
      viewportsRequested: viewportsReviewed,
      viewportsReviewed,
    },
  });

  it("counts them beside the sentence that says nothing is new", () => {
    const base = buildMeasurementBaseline(covering([at(["desktop"])], ["desktop"]), {
      commitSha: "basesha0000",
    });
    const onlyAtTheNewBreakpoint = at(["mobile"], { element: "nav .cta" });
    const comparison = compareMeasurementsToBaseline(
      covering([at(["desktop"]), onlyAtTheNewBreakpoint], ["desktop", "mobile"]),
      { lookup: { status: "found", snapshot: base } },
    );
    const section = baselineSection(comparison, { mode: "block" }) ?? "";

    expect(comparison.introduced).toEqual([]);
    expect(comparison.unclassified).toEqual([onlyAtTheNewBreakpoint]);
    expect(section).toContain("No measured violation above is new");
    expect(section).toMatch(/not a statement about the 1 violation\(s\) Gate could not place/);
  });

  it("does not add the qualifier when everything was placed", () => {
    const base = buildMeasurementBaseline(covering([at(["desktop"])], ["desktop"]), {
      commitSha: "basesha0000",
    });
    const section =
      baselineSection(
        compareMeasurementsToBaseline(covering([at(["desktop"])], ["desktop"]), {
          lookup: { status: "found", snapshot: base },
        }),
        { mode: "block" },
      ) ?? "";

    expect(section).toContain("No measured violation above is new");
    expect(section).not.toMatch(/could not place/);
  });
});

describe("a baseline whose rows are only partly placeable", () => {
  // Entries are written together, so a mixed snapshot means a stored row was
  // written or read back damaged: the jsonb reader drops a malformed viewport
  // list to absent one row at a time. Treating that snapshot as placeable would
  // quietly drop the damaged rows out of the comparison, and a violation could
  // be called worse than a band that is sitting right there in the baseline.
  it("falls back to the whole identity rather than ignoring the unplaceable rows", () => {
    const base = buildMeasurementBaseline(
      runOf([
        { ...TAGLINE, viewports: ["mobile"], severity: 1 },
        { ...TAGLINE, viewports: ["mobile"], severity: 3 },
      ]),
      { commitSha: "basesha0000" },
    );
    const damaged = {
      ...base,
      entries: base.entries.map((entry, index) =>
        index === 1 ? (({ viewports: _lost, ...rest }) => rest)(entry) : entry,
      ),
    };
    const now = { ...TAGLINE, viewports: ["mobile"] as const, severity: 2 };

    const comparison = compareMeasurementsToBaseline(runOf([now]), {
      lookup: { status: "found", snapshot: damaged },
    });

    // Band 3 is on the record for this identity. Band 2 is not a regression
    // against it, whatever happened to that row's viewport list.
    expect(comparison.worsened).toEqual([]);
  });
});

describe("which row the engine happens to report first decides nothing", () => {
  /**
   * A claim used to reach across viewports. A base that measured mobile alone
   * stores one row; a pull request that widens `viewports:` produces two rows of
   * that identity on untouched markup. If the DESKTOP row claimed the mobile
   * entry, the mobile row, byte for byte what the base recorded, had nothing
   * left to claim and was called introduced. The check went red or green
   * depending on the order the engine listed two rows in, and verdict captures
   * in the repository's own `viewports:` order, so a repository that listed its
   * new breakpoint first got the bad order on every run.
   */
  const at = (viewport: "mobile" | "desktop" | "tablet", over: Partial<Measurement> = {}): Measurement => ({
    ...TAGLINE,
    viewports: [viewport],
    severity: 2,
    ...over,
  });
  const covering = (
    violations: Measurement[],
    viewportsReviewed: GateReviewResult["coverage"]["viewportsReviewed"],
  ): GateReviewResult => ({
    ...runOf(violations),
    coverage: {
      routesRequested: ROUTES,
      routesReviewed: ROUTES,
      viewportsRequested: viewportsReviewed,
      viewportsReviewed,
    },
  });
  const base = buildMeasurementBaseline(covering([at("mobile")], ["mobile"]), {
    commitSha: "basesha0000",
  });

  const placeIn = (order: Measurement[]) =>
    compareMeasurementsToBaseline(covering(order, ["mobile", "desktop"]), {
      lookup: { status: "found", snapshot: base },
    });

  it("classifies a widened run the same way whichever row comes first", () => {
    const mobileFirst = placeIn([at("mobile"), at("desktop")]);
    const desktopFirst = placeIn([at("desktop"), at("mobile")]);

    for (const comparison of [mobileFirst, desktopFirst]) {
      expect(comparison.introduced).toEqual([]);
      expect(comparison.preExisting.map((row) => row.viewports)).toEqual([["mobile"]]);
      expect(comparison.unclassified.map((row) => row.viewports)).toEqual([["desktop"]]);
    }
  });

  it("fails no check in either order", () => {
    for (const order of [
      [at("mobile"), at("desktop")],
      [at("desktop"), at("mobile")],
    ]) {
      expect(
        buildCheckRun(covering(order, ["mobile", "desktop"]), "none", {
          measurements: "block",
          baseline: placeIn(order),
        }).conclusion,
      ).not.toBe("failure");
    }
  });

  it("still lets a claim go ahead when a stored row carries no viewports", () => {
    // Viewports cannot separate two rows when one side does not have them, and
    // a baseline written before the field existed must keep matching on
    // identity alone rather than losing every claim at once.
    const legacy = {
      ...base,
      entries: base.entries.map(({ viewports: _drop, ...entry }) => entry),
    };
    const comparison = compareMeasurementsToBaseline(covering([at("desktop")], ["desktop"]), {
      lookup: { status: "found", snapshot: legacy },
    });

    expect(comparison.preExisting).toHaveLength(1);
    expect(comparison.introduced).toEqual([]);
  });
});

describe("a violation is not gone from a viewport nobody measured", () => {
  // `resolved` is the one counter here that speaks in the flattering direction,
  // and it was scoped by route and by check but not by viewport. A base that
  // measured mobile and desktop, on a run that captured mobile alone, reported
  // its desktop violation as fixed.
  const desktopOnly: Measurement = { ...TAGLINE, viewports: ["desktop"], severity: 2 };
  const covering = (
    violations: Measurement[],
    viewportsReviewed: GateReviewResult["coverage"]["viewportsReviewed"],
  ): GateReviewResult => ({
    ...runOf(violations),
    coverage: {
      routesRequested: ROUTES,
      routesReviewed: ROUTES,
      viewportsRequested: viewportsReviewed,
      viewportsReviewed,
    },
  });
  const base = buildMeasurementBaseline(covering([desktopOnly], ["mobile", "desktop"]), {
    commitSha: "basesha0000",
  });

  it("does not count it as resolved when this run never looked there", () => {
    const comparison = compareMeasurementsToBaseline(covering([], ["mobile"]), {
      lookup: { status: "found", snapshot: base },
    });

    expect(comparison.resolved).toBe(0);
  });

  it("does count it when this run did look there and found nothing", () => {
    // The control. Scoping by viewport must not make a real fix invisible.
    const comparison = compareMeasurementsToBaseline(covering([], ["mobile", "desktop"]), {
      lookup: { status: "found", snapshot: base },
    });

    expect(comparison.resolved).toBe(1);
  });
});

describe("guards the band rules rest on that nothing was asserting", () => {
  const covering = (
    violations: Measurement[],
    viewportsReviewed: GateReviewResult["coverage"]["viewportsReviewed"],
    viewportsRequested = viewportsReviewed,
  ): GateReviewResult => ({
    ...runOf(violations),
    coverage: {
      routesRequested: ROUTES,
      routesReviewed: ROUTES,
      viewportsRequested,
      viewportsReviewed,
    },
  });
  const row = (viewports: Measurement["viewports"], severity: number, over: Partial<Measurement> = {}): Measurement => ({
    ...TAGLINE,
    viewports,
    severity,
    ...over,
  });

  it("compares against a stored row that covers MORE viewports than this one", () => {
    // The engine groups identical wording across viewports into ONE row, so a
    // stored row covering mobile and tablet against a row here covering mobile
    // is the normal shape rather than the exception. Requiring the stored row's
    // viewports to be a subset instead of an overlap loses the comparison.
    const base = buildMeasurementBaseline(
      covering([row(["mobile", "tablet"], 2)], ["mobile", "tablet"]),
      { commitSha: "basesha0000" },
    );
    const worse = row(["mobile"], 3);
    const comparison = compareMeasurementsToBaseline(covering([worse], ["mobile", "tablet"]), {
      lookup: { status: "found", snapshot: base },
    });

    expect(comparison.worsened).toEqual([worse]);
  });

  it("compares a legacy baseline rather than declining every band on it", () => {
    // The whole-identity fallback has to actually answer. Applying the viewport
    // coverage rule to rows that cannot be placed at a viewport would switch
    // regression detection off for every baseline stored before the column.
    const base = buildMeasurementBaseline(runOf([row(["mobile"], 1)]), {
      commitSha: "basesha0000",
    });
    const legacy = { ...base, entries: base.entries.map(({ viewports: _d, ...e }) => e) };
    const worse = row(["mobile"], 3);
    const comparison = compareMeasurementsToBaseline(runOf([worse]), {
      lookup: { status: "found", snapshot: legacy },
    });

    expect(comparison.worsened).toEqual([worse]);
  });

  it("still calls a violation new when the snapshot records no viewports at all", () => {
    // Unknown base viewports must not screen everything: that would turn `block`
    // into a no-op against a legacy baseline instead of a narrower rule.
    const base = buildMeasurementBaseline(runOf([row(["mobile"], 1)]), {
      commitSha: "basesha0000",
    });
    const { viewportsMeasured: _dropped, ...older } = base;
    const fresh = row(["mobile"], 2, { element: "#brand-new .cta" });
    const comparison = compareMeasurementsToBaseline(runOf([row(["mobile"], 1), fresh]), {
      lookup: { status: "found", snapshot: older },
    });

    expect(comparison.introduced).toEqual([fresh]);
  });

  it("declines to compare against a stored row measured nowhere", () => {
    // An empty list is not an absent one. Absent says nobody recorded the
    // viewports; empty says this row was measured at none of them, and a band
    // from nowhere cannot be the base for a regression.
    const base = buildMeasurementBaseline(runOf([row(["mobile"], 1)]), {
      commitSha: "basesha0000",
    });
    const nowhere = { ...base, entries: base.entries.map((e) => ({ ...e, viewports: [] })) };
    const comparison = compareMeasurementsToBaseline(runOf([row(["mobile"], 3)]), {
      lookup: { status: "found", snapshot: nowhere },
    });

    expect(comparison.worsened).toEqual([]);
  });

  it("does not excuse a violation whose own viewport list is empty", () => {
    // The engine contract does not require a viewport list to be non-empty, and
    // a row that names none must not fall through the unseen-viewport screen:
    // that would let an engine switch `block` off by omitting a field.
    const base = buildMeasurementBaseline(covering([row(["mobile"], 1)], ["mobile"]), {
      commitSha: "basesha0000",
    });
    // A distinct sentence as well as a distinct element, so the markup-refactor
    // tier has nothing to carry over and the row really does reach the screen.
    const fresh = row([], 2, {
      element: "#brand-new .cta",
      detail: "the control has no accessible name",
    });
    const comparison = compareMeasurementsToBaseline(covering([fresh], ["mobile"]), {
      lookup: { status: "found", snapshot: base },
    });

    expect(comparison.introduced).toEqual([fresh]);
  });

  it("records the viewports a run REVIEWED, not the ones it asked for", () => {
    // A base run that asked for desktop and never captured it has not measured
    // desktop, and treating the request as evidence makes every desktop
    // violation on the next pull request read as introduced.
    const base = buildMeasurementBaseline(
      covering([row(["mobile"], 1)], ["mobile"], ["mobile", "desktop"]),
      { commitSha: "basesha0000" },
    );
    const atDesktop = row(["desktop"], 2, { element: "#only-wide .cta" });
    const comparison = compareMeasurementsToBaseline(
      covering([atDesktop], ["mobile", "desktop"]),
      { lookup: { status: "found", snapshot: base } },
    );

    expect(comparison.introduced).toEqual([]);
    expect(comparison.classified[0]?.reason).toBe("viewport_not_measured");
  });

  it("counts a violation's own viewport as proof that viewport was measured", () => {
    // Coverage is one source of evidence and the violations are the other. A
    // violation reported at tablet is proof tablet was captured, whatever the
    // coverage block says.
    const base = buildMeasurementBaseline(
      covering([row(["tablet"], 1, { element: "#wide .thing" })], ["mobile"]),
      { commitSha: "basesha0000" },
    );

    expect(base.viewportsMeasured).toContain("tablet");
  });

  it("says viewport in the unplaceable reason, not check", () => {
    const base = buildMeasurementBaseline(covering([row(["mobile"], 1)], ["mobile"]), {
      commitSha: "basesha0000",
    });
    const comparison = compareMeasurementsToBaseline(
      covering([row(["mobile"], 1), row(["desktop"], 2, { element: "#x .y" })], ["mobile", "desktop"]),
      { lookup: { status: "found", snapshot: base } },
    );
    const section = baselineSection(comparison, { mode: "block" }) ?? "";

    expect(section).toContain("never measured that viewport");
  });

  it("does not blame the overflow exclusion on a run where it decided nothing", () => {
    // The note explains why a deepened overflow did not fail the check. An
    // overflow the engine already refuses to stand behind was never a candidate,
    // so claiming the exclusion is the reason is a false explanation.
    const advisoryOverflow = row(["mobile"], 3, {
      kind: "overflow",
      element: "#plans .grid",
      detail: "element is 412px wide inside a 390px viewport",
      blockEligible: false,
    });
    const base = buildMeasurementBaseline(
      covering([{ ...advisoryOverflow, severity: 1 }], ["mobile"]),
      { commitSha: "basesha0000" },
    );
    const section =
      baselineSection(
        compareMeasurementsToBaseline(covering([advisoryOverflow], ["mobile"]), {
          lookup: { status: "found", snapshot: base },
        }),
        { mode: "block" },
      ) ?? "";

    expect(section).not.toMatch(/never fails a check on one/);
  });

  it("does not tell an author an advisory-only violation failed their check", () => {
    // The closing sentence picks its wording from the worsened rows that can
    // gate. A worsening the engine marked advisory-only is not one of them.
    const advisoryWorse = row(["mobile"], 3, { element: "#soft .thing", blockEligible: false });
    const fresh = row(["mobile"], 2, { element: "#brand-new .cta" });
    const base = buildMeasurementBaseline(
      covering([{ ...advisoryWorse, severity: 1 }], ["mobile"]),
      { commitSha: "basesha0000" },
    );
    const section =
      baselineSection(
        compareMeasurementsToBaseline(covering([advisoryWorse, fresh], ["mobile"]), {
          lookup: { status: "found", snapshot: base },
        }),
        { mode: "block", blocking: true },
      ) ?? "";

    expect(section).toContain("so the new block-eligible violation(s)");
    expect(section).not.toMatch(/either introduced or moved into a worse severity band/);
  });
});

describe("what a snapshot is allowed to record", () => {
  // Two states that reach a stored row without going through the engine
  // contract, and one determinism property. None of them changes a verdict on
  // its own, which is exactly why nothing was watching them.
  it("refuses a band of zero rather than storing the best band there is", () => {
    // The engine contract rejects a zero at ingestion and the SQL reader rejects
    // it coming back, but the in-memory store rejects nothing. Without a refusal
    // here the hosted path and the Action path would disagree about the same
    // repository, and a zero compares as better than every real band.
    const snapshot = buildMeasurementBaseline(runOf([{ ...TAGLINE, severity: 0 }]), {
      commitSha: "basesha0000",
    });

    expect(snapshot.entries[0]).not.toHaveProperty("severity");
  });

  it("refuses a fractional band, which is a magnitude wearing a band's name", () => {
    const snapshot = buildMeasurementBaseline(runOf([{ ...TAGLINE, severity: 2.91 }]), {
      commitSha: "basesha0000",
    });

    expect(snapshot.entries[0]).not.toHaveProperty("severity");
  });

  it("stores a viewport list in a stable order", () => {
    // Every consumer builds a set out of this and would never notice the order,
    // so an unsorted list rots quietly. The snapshot is idempotent on
    // (repository, commit), and rewriting the same facts should not rewrite the
    // bytes.
    const one = buildMeasurementBaseline(
      runOf([{ ...TAGLINE, viewports: ["mobile", "desktop"] }]),
      { commitSha: "basesha0000" },
    );
    const other = buildMeasurementBaseline(
      runOf([{ ...TAGLINE, viewports: ["desktop", "mobile"] }]),
      { commitSha: "basesha0000" },
    );

    expect(one.entries[0]?.viewports).toEqual(other.entries[0]?.viewports);
    expect(JSON.stringify(one)).toBe(JSON.stringify(other));
  });
});
