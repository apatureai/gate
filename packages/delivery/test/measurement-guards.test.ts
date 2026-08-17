import { loadGoldenReviewResult, type GateReviewResult, type Measurement } from "@gate/types";
import { describe, expect, it } from "vitest";
import {
  BASELINE_SECTION_HEADING,
  baselineSection,
  buildCheckRun,
  buildMeasurementBaseline,
  compareMeasurementsToBaseline,
  decideDelivery,
  gateableMeasurements,
  measurementBlock,
  measurementsAreBlocking,
  renderStickyComment,
  type MeasurementBaselineLookup,
  type MeasurementBaselineSnapshot,
  type MeasurementComparison,
  type MeasurementsMode,
} from "../src/index.js";

/**
 * THE GUARDS THE BASELINE DESIGN RESTS ON, PINNED BY MEANING.
 *
 * Every claim in this file was unpinned: the guard was deleted from the source,
 * the whole suite stayed green, and the deletion changed what a maintainer is
 * told about their own pull request. The worst of them was the sentence that
 * separates "Gate has never looked at the base" from "Gate looked and the base
 * was clean". Those are opposite claims about opposite things, one about the
 * pull request and one about Gate's own ignorance, and a reader deciding whether
 * to trust a green check has no other way to tell them apart.
 *
 * WHY THESE TESTS DO NOT QUOTE THE PROSE. A test that pins a sentence verbatim
 * is deleted by the first person who improves the wording, and takes the
 * guarantee with it. So each guard here is pinned as a PROPERTY of the rendered
 * output, read by the small predicates below: a rewording that keeps the
 * distinction passes, a deletion that loses it fails. The predicates themselves
 * are pinned first, against hand-written rewordings and hand-written deletions,
 * so a predicate that has quietly become vacuous fails before it can wave a
 * broken guard through.
 */

/* ------------------------------------------------------------------ reading */

/**
 * Rough sentence split. Good enough to ask whether ONE sentence carries a whole
 * claim, which is the only question the predicates below ask. Markdown bold
 * ends a fragment with `**` rather than whitespace, so `**no baseline.**` stays
 * attached to the sentence it introduces, which is what a reader sees too.
 */
const sentencesOf = (text: string): string[] =>
  text
    .split(/(?<=[.!?])[\s\n]+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);

const NEGATION = /\b(not|never|no|none|nothing|cannot|can't|isn't|doesn't)\b/i;
const SAMENESS = /\b(same|equivalent|equal|means?|meaning|statement|claim|says?|saying)\b/i;
const NEWNESS = /\b(new|introduced?|introduces|introducing|added|adds)\b/i;
const CLEANLINESS = /\b(clean|clear|fine|passed|passing)\b/i;
const KNOWLEDGE = /\b(know|knows|look|looked|record|recorded|seen|saw|compared|read)\b/i;
/**
 * Deliberately without a bare `gate`: the product is called Gate, and "Gate has
 * never recorded a measurement set" is a statement about Gate, not a statement
 * that nothing is gating. Matching the name would let the disclaimer be deleted
 * and the guard still pass.
 */
const GATING = /\b(gated|gating|fail|fails|failed|failing|block|blocks|blocked|blocking|merge)\b/i;
/** Why a violation that looks different is nonetheless the old one. */
const CARRY_REASON = /\b(degree|measurement|markup|selector|wording|element|page|position)\b/i;

/**
 * Does this prose refuse the reading "Gate reported nothing new, therefore this
 * pull request is clean"?
 *
 * Two ways to say it and both count: denying that the two STATEMENTS are the
 * same one ("this is not the same claim as 'introduced no violations'"), or
 * denying the verdict directly ("this is not a report that the base was clean;
 * Gate does not know"). What does not count is merely being negative: "none of
 * these can be shown to be new" is the state, not the disclaimer, and it is
 * exactly the sentence a skimming reader mistakes for a pass.
 */
const deniesTheCleanReading = (text: string): boolean =>
  sentencesOf(text).some(
    (sentence) =>
      NEGATION.test(sentence) &&
      ((SAMENESS.test(sentence) && NEWNESS.test(sentence)) ||
        (CLEANLINESS.test(sentence) && KNOWLEDGE.test(sentence))),
  );

/** Does this prose say, in one sentence, that nothing here is failing anything? */
const statesNothingIsGating = (text: string): boolean =>
  sentencesOf(text).some((sentence) => NEGATION.test(sentence) && GATING.test(sentence));

/**
 * Does this prose state, without hedging it, that something failed the check?
 *
 * Narrower than `GATING` on purpose: `rules.measurements: block` is a config
 * value this surface quotes on every run under that mode, and quoting the word
 * `block` is not the claim that anything was blocked.
 */
const assertsAFailure = (text: string): boolean =>
  sentencesOf(text).some((sentence) => /\bfail(ed|s)?\b/i.test(sentence) && !NEGATION.test(sentence));

/**
 * Does this prose explain a violation that LOOKS different from the stored one
 * and is carried over anyway?
 *
 * The carry-over is the whole reason a markup refactor or a drifting ratio does
 * not manufacture a merge blocker, and a reader who sees a selector on the page
 * that is not the selector in the baseline is owed the reason it still counts as
 * the old defect.
 */
const explainsACarriedOverChange = (text: string): boolean =>
  sentencesOf(text).some(
    (sentence) =>
      NEGATION.test(sentence) && NEWNESS.test(sentence) && CARRY_REASON.test(sentence),
  );

/* ----------------------------------------------------------------- fixtures */

const violation = (over: Partial<Measurement> = {}): Measurement => ({
  kind: "contrast",
  route: "/pricing",
  viewports: ["mobile"],
  element: "#hero-subtitle",
  detail: "text contrast 3.23:1 is below WCAG AA 4.5:1",
  blockEligible: true,
  ...over,
});

const withMeasurements = (
  violations: Measurement[],
  over: Partial<GateReviewResult> = {},
): GateReviewResult => ({
  ...loadGoldenReviewResult(),
  measurements: { checksRun: ["contrast", "overflow", "touch_target"], violations },
  coverage: {
    routesRequested: ["/pricing", "/checkout"],
    routesReviewed: ["/pricing", "/checkout"],
    viewportsRequested: ["mobile", "desktop"],
    viewportsReviewed: ["mobile", "desktop"],
  },
  ...over,
});

const baselineOf = (
  violations: Measurement[],
  commitSha = "basesha0000",
): MeasurementBaselineSnapshot => buildMeasurementBaseline(withMeasurements(violations), { commitSha });

const found = (snapshot: MeasurementBaselineSnapshot): MeasurementBaselineLookup => ({
  status: "found",
  snapshot,
});

/** The four answers to "what is stored for the base commit". */
const LOOKUPS: Array<{ name: string; lookup: MeasurementBaselineLookup; gates: boolean }> = [
  { name: "absent", lookup: { status: "absent", baseSha: "basesha0000" }, gates: false },
  {
    name: "unavailable",
    lookup: { status: "unavailable", baseSha: "basesha0000", detail: "the store could not be read" },
    gates: false,
  },
  {
    name: "version_skew",
    lookup: found({ ...baselineOf([violation()]), version: "m0" }),
    gates: false,
  },
  { name: "compared", lookup: found(baselineOf([])), gates: true },
];

const section = (comparison: MeasurementComparison, mode: MeasurementsMode = "advisory"): string =>
  baselineSection(comparison, { mode }) ?? "";

/* ------------------------------------------------------- the predicates work */

describe("the predicates these guards are read with", () => {
  // Pinned FIRST, so a predicate that has rotted into "always true" is caught
  // here rather than silently passing every guard below it.
  const REWORDINGS = [
    // The claim denied as a claim.
    "There is no stored baseline for the base commit, so nothing above can be shown to be new. " +
      "Do not read that as a claim that this pull request introduced nothing.",
    // The verdict denied directly.
    "Gate never looked at the base, so this is not a report that the base was clean.",
    // Shorter, and in the other order.
    "This is not the same statement as 'no new violations were introduced'.",
  ];

  const DELETIONS = [
    // The state, with the disclaimer removed. The exact mutation that survived.
    "Gate has never recorded a measurement set for base commit `abc1234`, so none of the " +
      "violations above can be shown to be new and none of them are gating. Run Gate on the base " +
      "branch to record one.",
    // A real comparison against a clean base: the opposite claim, legitimately made.
    "Compared against the measurement set stored for base `abc1234`, which recorded no violations " +
      "on the routes and checks it covered: 0 introduced by this pull request, 1 already on the base.",
  ];

  it("accepts a rewording that keeps the distinction", () => {
    for (const prose of REWORDINGS) expect(deniesTheCleanReading(prose)).toBe(true);
  });

  it("rejects prose that has lost the distinction, including prose still full of negatives", () => {
    for (const prose of DELETIONS) expect(deniesTheCleanReading(prose)).toBe(false);
  });

  it("tells 'nothing is gating' from a page that merely mentions gating", () => {
    expect(statesNothingIsGating("Nothing here is gating.")).toBe(true);
    expect(statesNothingIsGating("None of them fail this check.")).toBe(true);
    expect(statesNothingIsGating("This repository sets `rules.measurements: block`.")).toBe(false);
    expect(statesNothingIsGating("The two cannot be compared.")).toBe(false);
    // The product's own name is not a claim about gating.
    expect(
      statesNothingIsGating("Gate has never recorded a measurement set for the base commit."),
    ).toBe(false);
  });

  it("tells an assertion that something failed from a mention of the setting", () => {
    expect(assertsAFailure("The new block-eligible violations above failed this check.")).toBe(true);
    expect(assertsAFailure("Nothing here failed the check.")).toBe(false);
    expect(assertsAFailure("This repository sets `rules.measurements: block`.")).toBe(false);
  });

  it("tells a carried-over change from a plain carry-over", () => {
    expect(
      explainsACarriedOverChange(
        "1 of them is the same defect on the same element with a different measurement, which is " +
          "a change in degree and not a new violation.",
      ),
    ).toBe(true);
    expect(
      explainsACarriedOverChange(
        "1 of them sits on a different selector after a markup change, and is not a new violation.",
      ),
    ).toBe(true);
    expect(
      explainsACarriedOverChange(
        "No measured violation above is new: every one Gate could place against the base was " +
          "already there before this pull request.",
      ),
    ).toBe(false);
  });
});

/* ------------------------------------------ guard 1: ignorance is not a pass */

describe("no baseline never reads like a clean base", () => {
  const result = withMeasurements([violation()]);
  const noBaseline = compareMeasurementsToBaseline(result, {
    lookup: { status: "absent", baseSha: "basesha0000" },
  });
  const unavailable = compareMeasurementsToBaseline(result, {
    lookup: { status: "unavailable", baseSha: "basesha0000", detail: "the store could not be read" },
  });
  const cleanBase = compareMeasurementsToBaseline(result, { lookup: found(baselineOf([])) });

  it("denies the clean reading in its own words, under every mode that renders", () => {
    // The honesty distinction, pinned by meaning: reword it however you like,
    // but the section may not stop saying that Gate's silence is ignorance
    // rather than a verdict. Deleting the sentence fails here; rewriting it
    // does not.
    for (const mode of ["advisory", "block"] as const) {
      expect(deniesTheCleanReading(section(noBaseline, mode))).toBe(true);
      expect(deniesTheCleanReading(section(unavailable, mode))).toBe(true);
    }
  });

  it("does not make that denial when it has actually compared, because there it would be a lie", () => {
    // The differential that makes the guard above mean something: the same
    // predicate must separate the two renderings, not pass everything.
    expect(deniesTheCleanReading(section(cleanBase))).toBe(false);
    expect(section(noBaseline)).not.toBe(section(cleanBase));
  });

  it("carries the denial onto both published surfaces, not just the one", () => {
    // A maintainer reads whichever of the two is in front of them, and the
    // merge-gating one must never be the more confident.
    const decision = decideDelivery(
      { status: "completed", result },
      {
        headSha: "head",
        gate: "none",
        measurements: "block",
        measurementBaseline: { status: "absent", baseSha: "basesha0000" },
      },
    );

    expect(deniesTheCleanReading(decision.comment ?? "")).toBe(true);
    expect(deniesTheCleanReading(decision.checkRun.summary)).toBe(true);
  });
});

/* --------------------------------- guard 2: an uncomparable state never gates */

describe("every answer that is not a usable baseline gates nothing and says so", () => {
  const eligible = withMeasurements([violation({ blockEligible: true })]);

  for (const { name, lookup, gates } of LOOKUPS) {
    if (gates) continue;
    it(`${name}: classifies nothing as introduced, fails no check, and states it is not gating`, () => {
      const comparison = compareMeasurementsToBaseline(eligible, { lookup });

      expect(comparison.introduced).toEqual([]);
      expect(gateableMeasurements(comparison)).toEqual([]);

      const decision = decideDelivery(
        { status: "completed", result: eligible },
        { headSha: "head", gate: "none", measurements: "block", measurementBaseline: lookup },
      );
      expect(decision.checkRun.conclusion).not.toBe("failure");

      // ...and the reader is told that, rather than left to infer it from a
      // check that happens not to be red. Asserted under advisory as well as
      // under block, so the sentence cannot come only from the block footer.
      for (const mode of ["advisory", "block"] as const) {
        expect(statesNothingIsGating(section(comparison, mode))).toBe(true);
      }
      expect(statesNothingIsGating(decision.checkRun.summary)).toBe(true);
      expect(statesNothingIsGating(decision.comment ?? "")).toBe(true);
    });
  }

  it("still fails the check when the base was measured and this violation is genuinely new", () => {
    // The other direction, and the reason none of the above may be loosened
    // into "nothing is ever new": a comparable baseline that recorded nothing
    // makes a block-eligible violation introduced, and `block` fails on it.
    const decision = decideDelivery(
      { status: "completed", result: eligible },
      {
        headSha: "head",
        gate: "none",
        measurements: "block",
        measurementBaseline: found(baselineOf([])),
      },
    );

    expect(decision.measurementBaseline).toBe("compared");
    expect(decision.checkRun.conclusion).toBe("failure");
    expect(decision.introducedMeasurementKinds).toEqual(["contrast"]);
  });
});

/* -------------------------------------------- guard 3: what each mode does do */

describe("rules.measurements does exactly what it says", () => {
  const carried = violation();
  const added = violation({ element: "#new-banner", detail: "text contrast 2.10:1 is below WCAG AA 4.5:1" });
  const result = withMeasurements([carried, added]);
  const lookup = found(baselineOf([carried]));

  it("off publishes the same bytes whether or not the run was scoped at all", () => {
    // `off` means off. Not "off, except for a second section that prints the
    // same evidence through another door": a repository that has switched
    // measurement reporting off has not consented to a scoped restatement of it.
    const scoped = decideDelivery(
      { status: "completed", result },
      { headSha: "head", gate: "none", measurements: "off", measurementBaseline: lookup },
    );
    const unscoped = decideDelivery(
      { status: "completed", result },
      { headSha: "head", gate: "none", measurements: "off" },
    );

    expect(scoped.comment).toBe(unscoped.comment);
    expect(scoped.checkRun.summary).toBe(unscoped.checkRun.summary);
    expect(scoped.checkRun.conclusion).toBe(unscoped.checkRun.conclusion);
  });

  it("off renders no scoped section for any baseline state, however much there is to say", () => {
    for (const { lookup: state } of LOOKUPS) {
      const comparison = compareMeasurementsToBaseline(result, { lookup: state });
      expect(baselineSection(comparison, { mode: "off" })).toBeNull();
    }
    // Including the one that has a resolved violation and a heading to print.
    const fixed = compareMeasurementsToBaseline(withMeasurements([]), {
      lookup: found(baselineOf([violation({ element: "#was-broken" })])),
    });
    expect(fixed.resolved).toBe(1);
    expect(baselineSection(fixed, { mode: "off" })).toBeNull();
  });

  it("advisory never fails a check, whatever the baseline says is new", () => {
    const comparison = compareMeasurementsToBaseline(result, { lookup });
    expect(comparison.introduced).toEqual([added]);

    for (const mode of ["off", "advisory"] as const) {
      const decision = decideDelivery(
        { status: "completed", result },
        { headSha: "head", gate: "none", measurements: mode, measurementBaseline: lookup },
      );
      expect(decision.checkRun.conclusion).not.toBe("failure");
    }
    // Same violation, same baseline, one word of config apart.
    expect(
      decideDelivery(
        { status: "completed", result },
        { headSha: "head", gate: "none", measurements: "block", measurementBaseline: lookup },
      ).checkRun.conclusion,
    ).toBe("failure");
  });

  it("under block, the closing sentence agrees with the conclusion beside it", () => {
    // The scoped section is the only place that says, in words, whether this
    // repository's `block` setting acted on this run. Said backwards it is worse
    // than saying nothing: a reader with a red check is told nothing failed, or
    // a reader with a green one is told their violations failed it, and either
    // way the surface disagrees with the check it is attached to.
    const preExisting = withMeasurements([carried]);

    const closingOf = (target: GateReviewResult, comparison: MeasurementComparison): string =>
      baselineSection(comparison, {
        mode: "block",
        blocking: measurementsAreBlocking(target, "block", [], comparison),
      }) ?? "";

    const gatingComparison = compareMeasurementsToBaseline(result, { lookup });
    const quietComparison = compareMeasurementsToBaseline(preExisting, { lookup });

    expect(buildCheckRun(result, "none", { measurements: "block", baseline: gatingComparison }).conclusion).toBe(
      "failure",
    );
    expect(
      buildCheckRun(preExisting, "none", { measurements: "block", baseline: quietComparison }).conclusion,
    ).not.toBe("failure");

    expect(assertsAFailure(closingOf(result, gatingComparison))).toBe(true);
    expect(assertsAFailure(closingOf(preExisting, quietComparison))).toBe(false);
    expect(statesNothingIsGating(closingOf(preExisting, quietComparison))).toBe(true);
  });

  it("under block, tells a reader eligibility alone is not what failed anything", () => {
    // A pre-existing block-eligible violation under `block` is the case that
    // reads wrong if the sentence is unqualified: the engine says it will stand
    // behind this one for failing a check, the check is not failing, and unless
    // the missing condition is named the reader is left to guess whether Gate
    // or their config is broken.
    const preExisting = withMeasurements([carried]);
    const notGating = measurementBlock(preExisting, {
      mode: "block",
      baseline: compareMeasurementsToBaseline(preExisting, { lookup }),
    }) as string;
    const gating = measurementBlock(result, {
      mode: "block",
      baseline: compareMeasurementsToBaseline(result, { lookup }),
    }) as string;

    const eligibilitySentence = (block: string): string =>
      sentencesOf(block).find((sentence) => /eligib/i.test(sentence)) ?? "";

    expect(eligibilitySentence(notGating)).not.toBe("");
    expect(eligibilitySentence(notGating)).not.toBe(eligibilitySentence(gating));
    expect(NEWNESS.test(eligibilitySentence(notGating))).toBe(true);
  });
});

/* ------------------------ guard 4: only the engine's eligible ones ever gate */

describe("blockEligible is a filter, not a decoration", () => {
  const eligible = violation({ element: "#new-banner" });
  const inconclusive = violation({ element: "#wide-pre", kind: "overflow", blockEligible: false });

  const comparisonOf = (violations: Measurement[]): MeasurementComparison =>
    compareMeasurementsToBaseline(withMeasurements(violations), { lookup: found(baselineOf([])) });

  it("keeps an introduced violation the engine will not stand behind out of the gating set", () => {
    const comparison = comparisonOf([eligible, inconclusive]);

    expect(comparison.introduced).toHaveLength(2);
    expect(gateableMeasurements(comparison)).toEqual([eligible]);
    expect(gateableMeasurements(comparisonOf([inconclusive]))).toEqual([]);
  });

  it("counts only those in the sentence that tells a reader what to fix", () => {
    // The headline number is what an author acts on. Counting the ones that
    // cannot gate would send them to fix a violation that was never the reason
    // their check is red.
    const headlineCount = (summary: string): number =>
      Number(/\d+/.exec(summary.split("\n\n")[0] ?? "")?.[0] ?? -1);

    const mixed = comparisonOf([eligible, inconclusive]);
    const bothEligible = comparisonOf([eligible, violation({ element: "#second-banner" })]);

    const runOf = (result: GateReviewResult, baseline: MeasurementComparison): string =>
      buildCheckRun(result, "none", { measurements: "block", baseline }).summary;

    const mixedSummary = runOf(withMeasurements([eligible, inconclusive]), mixed);
    const bothSummary = runOf(
      withMeasurements([eligible, violation({ element: "#second-banner" })]),
      bothEligible,
    );

    expect(headlineCount(mixedSummary)).toBe(gateableMeasurements(mixed).length);
    expect(headlineCount(bothSummary)).toBe(gateableMeasurements(bothEligible).length);
    // ...and the two really do differ, so neither line above can be satisfied by
    // a count that ignores eligibility entirely.
    expect(headlineCount(mixedSummary)).not.toBe(headlineCount(bothSummary));
  });
});

/* ------------------- guard 5: a violation that moved is said to have moved */

describe("a carried-over violation that looks different says why it still counts", () => {
  const base = violation({ element: "#hero .tagline", detail: "text contrast 2.91:1 is below WCAG AA 4.5:1" });
  const lookup = found(baselineOf([base]));

  const sectionFor = (now: Measurement): string =>
    section(compareMeasurementsToBaseline(withMeasurements([now]), { lookup }));

  /** The engine rewrote its own sentence about the same element. */
  const REWORDED = { ...base, detail: "contrast ratio below the WCAG AA threshold" };
  /** A wrapper div and a renamed class: the same defect, a different selector. */
  const REFACTORED = { ...base, element: "#hero .inner > .subtitle" };

  const exact = sectionFor(base);
  const restated = sectionFor(REWORDED);
  const refactored = sectionFor(REFACTORED);

  it("is pre-existing in all three shapes", () => {
    for (const now of [base, REWORDED, REFACTORED]) {
      const comparison = compareMeasurementsToBaseline(withMeasurements([now]), { lookup });
      expect(comparison.introduced).toEqual([]);
      expect(comparison.preExisting).toHaveLength(1);
    }
  });

  it("says nothing extra when the violation is identical to the stored one", () => {
    expect(explainsACarriedOverChange(exact)).toBe(false);
  });

  it("explains a violation the engine restated in different words", () => {
    // Without this the reader sees a sentence on the page that is not the
    // sentence in the baseline, and has no way to tell an engine that reworded
    // itself from a defect that changed.
    expect(explainsACarriedOverChange(restated)).toBe(true);
    expect(restated).not.toBe(exact);
  });

  it("explains a violation whose selector moved under a markup change", () => {
    expect(explainsACarriedOverChange(refactored)).toBe(true);
    expect(refactored).not.toBe(exact);
    expect(refactored).not.toBe(restated);
  });
});

/* --------------- guard 6: the scoped section is identifiable as what it is */

describe("the scoped section announces whose violations it is talking about", () => {
  const result = withMeasurements([violation()]);

  it("opens with a heading that names the pull request, on every baseline state", () => {
    // The section sits directly under a list of every violation on the page. A
    // heading that does not say "this pull request" leaves its counts reading as
    // a second opinion about the same list, which is the misreading the whole
    // section exists to prevent.
    expect(BASELINE_SECTION_HEADING).toMatch(/\b(this pull request|pull request|PR)\b/i);

    for (const { lookup } of LOOKUPS) {
      const rendered = section(compareMeasurementsToBaseline(result, { lookup }));
      expect(rendered.startsWith(BASELINE_SECTION_HEADING)).toBe(true);
    }
  });

  it("is not the same heading as the measured block it sits under", () => {
    const comparison = compareMeasurementsToBaseline(result, { lookup: found(baselineOf([])) });
    const measured = measurementBlock(result, { mode: "advisory", baseline: comparison }) as string;
    const scoped = section(comparison);
    const comment = renderStickyComment(result, { headSha: "head", baseline: comparison });

    expect(measured.split("\n")[0]).not.toBe(scoped.split("\n")[0]);
    // Both are published, in that order, and a reader can tell them apart.
    expect(comment.indexOf(measured)).toBeGreaterThan(-1);
    expect(comment.indexOf(scoped)).toBeGreaterThan(comment.indexOf(measured));
  });
});
