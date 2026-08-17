import { loadGoldenReviewResult, type GateReviewResult, type Measurement } from "@gate/types";
import { describe, expect, it } from "vitest";
import {
  baselineSection,
  buildCheckRun,
  buildMeasurementBaseline,
  compareMeasurementsToBaseline,
  decideDelivery,
  gateableMeasurements,
  measurementsAreBlocking,
  type MeasurementBaselineLookup,
  type MeasurementBaselineSnapshot,
  type MeasurementComparison,
} from "../src/index.js";

/**
 * A VIOLATION THAT WAS ALREADY HERE, MADE MATERIALLY WORSE.
 *
 * Every baseline key strips the numbers out of the engine's sentence before
 * hashing, and it has to: a contrast ratio drifting 2.91 -> 2.87 on an unchanged
 * page must not read as one violation fixed plus one introduced. The cost was
 * silent and total. A pull request could take an element from 2.91:1 to 1.02:1,
 * the fingerprint matched exactly, and Gate reported it as pre-existing and
 * unchanged. A real regression on markup that already had a defect walked
 * through a `block` gate without a word.
 *
 * The engine now states an ordinal `severity` BAND, Gate stores it beside the
 * keys, and Gate compares bands and nothing else. Raw magnitudes still never
 * cross the boundary, and Gate still never decides which DIRECTION is worse.
 *
 * THE CASE THAT MATTERS MOST HERE IS THE ONE WHERE NOTHING HAPPENS. A band Gate
 * does not have on one side of the comparison is unknown, and unknown never
 * gates: an older engine, a baseline stored before the field existed, and a
 * check that computes no band each have to leave the gate exactly where it was.
 * Those three are tested one at a time, because they fail one at a time.
 */

/* ----------------------------------------------------------------- fixtures */

const violation = (over: Partial<Measurement> = {}): Measurement => ({
  kind: "contrast",
  route: "/pricing",
  viewports: ["mobile"],
  element: "#hero-subtitle",
  detail: "text contrast 2.91:1 is below WCAG AA 4.5:1",
  blockEligible: true,
  severity: 2,
  ...over,
});

/**
 * The same defect, measured worse. The engine's sentence differs only in its
 * numbers, so it hashes to the SAME fingerprint: this violation reaches the
 * strongest tier there is and is placed as pre-existing, which is precisely why
 * the band is the only thing that can tell it apart from an unchanged one.
 */
const worse = (over: Partial<Measurement> = {}): Measurement =>
  violation({ detail: "text contrast 1.02:1 is below WCAG AA 4.5:1", severity: 3, ...over });

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

const baselineOf = (violations: Measurement[]): MeasurementBaselineSnapshot =>
  buildMeasurementBaseline(withMeasurements(violations), { commitSha: "basesha0000" });

const found = (snapshot: MeasurementBaselineSnapshot): MeasurementBaselineLookup => ({
  status: "found",
  snapshot,
});

/** This run's violations placed against a base that held `base`. */
const compare = (now: Measurement[], base: Measurement[]): MeasurementComparison =>
  compareMeasurementsToBaseline(withMeasurements(now), { lookup: found(baselineOf(base)) });

const conclusionFor = (
  now: Measurement[],
  base: Measurement[],
  mode: "off" | "advisory" | "block" = "block",
): string =>
  decideDelivery(
    { status: "completed", result: withMeasurements(now) },
    {
      headSha: "head",
      gate: "none",
      measurements: mode,
      measurementBaseline: found(baselineOf(base)),
    },
  ).checkRun.conclusion;

const sectionFor = (
  comparison: MeasurementComparison,
  mode: "off" | "advisory" | "block" = "advisory",
): string =>
  baselineSection(comparison, {
    mode,
    blocking: measurementsAreBlocking(
      withMeasurements(comparison.classified.map((row) => row.measurement)),
      mode,
      [],
      comparison,
    ),
  }) ?? "";

/** Rough sentence split, the same one the other guard file reads prose with. */
const sentencesOf = (text: string): string[] =>
  text
    .split(/(?<=[.!?])[\s\n]+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);

const WORSE_WORD = /\b(worse|worsened|worsens|degrad\w*|regress\w*)\b/i;
const NEWNESS = /\b(new|introduced?|introduces|introducing|added|adds)\b/i;
const NEGATION = /\b(not|never|no|none|nothing|cannot|can't|isn't|doesn't)\b/i;

/**
 * Does this prose say, in one sentence, that a violation was ALREADY HERE and
 * this pull request made it worse?
 *
 * Both halves are required. "Worse" on its own could be a sentence about a new
 * violation being bad; "already there" on its own is the ordinary carry-over
 * sentence that has always been printed. The claim only exists when a reader
 * gets them together, because that is the claim that is neither "new" nor
 * "unchanged".
 */
const saysAlreadyHereAndWorse = (text: string): boolean =>
  sentencesOf(text).some(
    (sentence) => WORSE_WORD.test(sentence) && /\b(already|base|before|pre-existing)\b/i.test(sentence),
  );

/** Does this prose tell a reader nothing above is new? */
const claimsNothingIsNew = (text: string): boolean =>
  sentencesOf(text).some((sentence) => NEGATION.test(sentence) && NEWNESS.test(sentence) && /\babove\b/i.test(sentence));

/* --------------------------------------------------------- storing the band */

describe("the band is stored beside the keys, and absence is stored as absence", () => {
  it("records the band the engine stated", () => {
    const [entry] = baselineOf([violation({ severity: 2 })]).entries;
    expect(entry?.severity).toBe(2);
  });

  it("writes no band at all for a violation that has none", () => {
    // Not `undefined`, not `0`: the key is absent, so a snapshot round-tripped
    // through jsonb says "this engine did not state a band" rather than "this
    // engine stated the best band there is".
    const [entry] = baselineOf([violation({ severity: undefined })]).entries;
    expect(entry).not.toHaveProperty("severity");
  });

  it("does not move the identity version, and does not move any key", () => {
    // A band is a fact ABOUT a violation, not what makes two violations the
    // same one. If it reached a key, every stored baseline in the field would
    // stop comparing the day an engine started stating bands.
    const [banded] = baselineOf([violation({ severity: 3 })]).entries;
    const [unbanded] = baselineOf([violation({ severity: undefined })]).entries;

    expect(banded?.fingerprint).toBe(unbanded?.fingerprint);
    expect(banded?.elementKey).toBe(unbanded?.elementKey);
    expect(banded?.defectKey).toBe(unbanded?.defectKey);
    expect(baselineOf([violation()]).version).toBe(baselineOf([]).version);
  });
});

/* ------------------------------------------------------- comparing the band */

describe("a pre-existing violation whose band went up is worsened", () => {
  it("finds the regression the fingerprint match used to hide", () => {
    const comparison = compare([worse()], [violation()]);
    const [row] = comparison.classified;

    // The proof that this is the hidden case and not a different one: the
    // violation matched the strongest key there is.
    expect(row?.origin).toBe("pre_existing");
    expect(row?.detailChanged).toBeUndefined();
    expect(row?.elementChanged).toBeUndefined();

    expect(row?.worsened).toBe(true);
    expect(row?.baselineSeverity).toBe(2);
    expect(row?.currentSeverity).toBe(3);
    expect(comparison.worsened).toEqual([worse()]);
  });

  it("says nothing when the band did not move", () => {
    const comparison = compare([violation()], [violation()]);
    expect(comparison.worsened).toEqual([]);
    expect(comparison.classified[0]?.worsened).toBeUndefined();
  });

  it("says nothing when the band went DOWN, which is the same page getting better", () => {
    const comparison = compare([violation({ severity: 1 })], [violation({ severity: 3 })]);
    expect(comparison.worsened).toEqual([]);
    expect(comparison.preExisting).toHaveLength(1);
  });

  it("compares strictly, so an unmoved band is never a regression at any band", () => {
    for (const band of [1, 2, 3]) {
      expect(compare([violation({ severity: band })], [violation({ severity: band })]).worsened).toEqual([]);
    }
  });

  it("puts the before and the after on the row, so a reader is not asked to trust a verdict", () => {
    const [row] = compare([worse()], [violation()]).classified;
    expect(row?.baselineSeverity).toBe(2);
    expect(row?.currentSeverity).toBe(3);
  });
});

describe("every tier that places a violation as pre-existing can also find it worsened", () => {
  it("finds it through the element key, when the engine reworded its own sentence", () => {
    const reworded = worse({ detail: "contrast ratio below the WCAG AA threshold" });
    const [row] = compare([reworded], [violation()]).classified;

    expect(row?.origin).toBe("pre_existing");
    expect(row?.detailChanged).toBe(true);
    expect(row?.worsened).toBe(true);
  });

  it("finds it through the defect key, when a markup refactor moved the selector", () => {
    const refactored = violation({ element: "#hero .inner > .subtitle", severity: 3 });
    const [row] = compare([refactored], [violation({ element: "#hero-subtitle" })]).classified;

    expect(row?.origin).toBe("pre_existing");
    expect(row?.elementChanged).toBe(true);
    expect(row?.worsened).toBe(true);
  });

  it("takes the worst recorded band under engine skew, where no single entry is claimed", () => {
    // The lenient element match under skew is the one tier that MATCHES without
    // spending, so there is no one entry to read a band off. One unbanded entry
    // on that element makes the whole answer unknown, and one BANDED entry that
    // happens to be lower must not be picked out of the set instead: under skew
    // a new engine may report as several rows what the old one reported as one,
    // and a false "worsened" is a red check on work that did not cause it.
    const stored = (over: Partial<Measurement>) => violation({ element: "#hero-subtitle", ...over });
    const now = violation({
      element: "#hero-subtitle",
      detail: "contrast ratio below the WCAG AA threshold",
      severity: 2,
    });

    const unknownAmongThem = compareMeasurementsToBaseline(
      withMeasurements([now], { metadata: { ...loadGoldenReviewResult().metadata, engineVersion: "engine-2" } }),
      {
        lookup: found(
          buildMeasurementBaseline(
            withMeasurements(
              [
                stored({ detail: "text contrast 2.91:1 is below WCAG AA 4.5:1", severity: undefined }),
                stored({ detail: "text contrast 2.91:1 is below WCAG AAA 7:1", severity: 1 }),
              ],
              { metadata: { ...loadGoldenReviewResult().metadata, engineVersion: "engine-1" } },
            ),
            { commitSha: "basesha0000" },
          ),
        ),
      },
    );

    expect(unknownAmongThem.engineSkew).toEqual({ baseline: "engine-1", current: "engine-2" });
    expect(unknownAmongThem.preExisting).toEqual([now]);
    expect(unknownAmongThem.worsened).toEqual([]);

    // The differential: band every stored entry and the same run is worsened,
    // against the WORST of them, so none of the above is "skew never worsens".
    const allBanded = compareMeasurementsToBaseline(
      withMeasurements([now], { metadata: { ...loadGoldenReviewResult().metadata, engineVersion: "engine-2" } }),
      {
        lookup: found(
          buildMeasurementBaseline(
            withMeasurements(
              [
                stored({ detail: "text contrast 2.91:1 is below WCAG AA 4.5:1", severity: 1 }),
                stored({ detail: "text contrast 2.91:1 is below WCAG AAA 7:1", severity: 1 }),
              ],
              { metadata: { ...loadGoldenReviewResult().metadata, engineVersion: "engine-1" } },
            ),
            { commitSha: "basesha0000" },
          ),
        ),
      },
    );
    expect(allBanded.worsened).toEqual([now]);
    expect(allBanded.classified[0]?.baselineSeverity).toBe(1);
  });

  it("reads the band off the entry this violation actually claimed", () => {
    // Two same-defect violations on one page, stored at different bands, and one
    // of them is now worse. Comparing against the wrong entry would either miss
    // the regression or invent one, and both are wrong in a way a reader acts on.
    const mild = violation({ element: "#a", severity: 1 });
    const severe = violation({ element: "#b", severity: 3 });
    const comparison = compare(
      [violation({ element: "#a", severity: 2 }), violation({ element: "#b", severity: 3 })],
      [mild, severe],
    );

    expect(comparison.worsened.map((row) => row.element)).toEqual(["#a"]);
  });
});

/* --------------------------------- the load-bearing case: unknown never gates */

describe("an unknown band on either side never gates, and each side fails separately", () => {
  it("an OLD STORED BASELINE, recorded before the field existed, does not gate", () => {
    const comparison = compare([worse()], [violation({ severity: undefined })]);

    expect(comparison.worsened).toEqual([]);
    expect(comparison.classified[0]?.worsened).toBeUndefined();
    expect(comparison.classified[0]?.baselineSeverity).toBeUndefined();
    expect(gateableMeasurements(comparison)).toEqual([]);
    expect(conclusionFor([worse()], [violation({ severity: undefined })])).not.toBe("failure");
  });

  it("an OLD ENGINE, which states no band on this run, does not gate", () => {
    const now = worse({ severity: undefined });
    const comparison = compare([now], [violation({ severity: 1 })]);

    expect(comparison.worsened).toEqual([]);
    expect(comparison.classified[0]?.currentSeverity).toBeUndefined();
    expect(gateableMeasurements(comparison)).toEqual([]);
    expect(conclusionFor([now], [violation({ severity: 1 })])).not.toBe("failure");
  });

  it("a CHECK THAT COMPUTES NO BAND on either side does not gate", () => {
    const base = violation({ kind: "overflow", element: "#wide", severity: undefined });
    const now = violation({
      kind: "overflow",
      element: "#wide",
      detail: "text contrast 9.99:1 is below WCAG AA 4.5:1",
      severity: undefined,
    });
    const comparison = compare([now], [base]);

    expect(comparison.preExisting).toHaveLength(1);
    expect(comparison.worsened).toEqual([]);
    expect(gateableMeasurements(comparison)).toEqual([]);
    expect(conclusionFor([now], [base])).not.toBe("failure");
  });

  it("still gates when both bands are known, so none of the above is 'worsened never gates'", () => {
    // The differential. Without it every assertion above is satisfied by code
    // that simply never reports a worsened violation.
    const comparison = compare([worse()], [violation()]);
    expect(gateableMeasurements(comparison)).toEqual([worse()]);
    expect(conclusionFor([worse()], [violation()])).toBe("failure");
  });
});

/* ------------------------------------------------- the tiers are unchanged */

describe("a worsened violation is still a pre-existing one", () => {
  const comparison = compare([worse()], [violation()]);

  it("is pre-existing and is not introduced", () => {
    expect(comparison.classified[0]?.origin).toBe("pre_existing");
    expect(comparison.introduced).toEqual([]);
    expect(comparison.preExisting).toEqual([worse()]);
  });

  it("is counted inside preExisting rather than beside it", () => {
    // `worsened` is a SUBSET, not a fourth bucket: a violation counted once as
    // carried over and once as new is how two surfaces start disagreeing.
    for (const row of comparison.worsened) expect(comparison.preExisting).toContain(row);
  });

  it("does not move `resolved`, because a violation that got worse did not go away", () => {
    expect(comparison.resolved).toBe(0);
    // The differential: the same baseline entry with nothing reported against it
    // really is resolved, so the assertion above is not vacuous.
    expect(compare([], [violation()]).resolved).toBe(1);
  });

  it("leaves an introduced violation introduced and nothing else", () => {
    const added = violation({ element: "#new-banner", severity: 3 });
    const both = compare([worse(), added], [violation()]);

    expect(both.introduced).toEqual([added]);
    expect(both.worsened).toEqual([worse()]);
    expect(both.preExisting).toEqual([worse()]);
  });
});

/* ------------------------------------------------------- acting on the band */

describe("rules.measurements decides what a worsened violation does", () => {
  it("fails the check under block, on the same block-eligibility rule as a new one", () => {
    expect(conclusionFor([worse()], [violation()])).toBe("failure");
  });

  it("fails nothing when the engine will not stand behind the measurement", () => {
    const inconclusive = worse({ blockEligible: false });
    const base = violation({ blockEligible: false });
    const comparison = compare([inconclusive], [base]);

    expect(comparison.worsened).toEqual([inconclusive]);
    expect(gateableMeasurements(comparison)).toEqual([]);
    expect(conclusionFor([inconclusive], [base])).not.toBe("failure");
  });

  it("fails nothing under advisory or off, whatever the bands say", () => {
    for (const mode of ["off", "advisory"] as const) {
      expect(conclusionFor([worse()], [violation()], mode)).not.toBe("failure");
    }
  });

  it("puts introduced and worsened in the gating set, introduced first, without merging them", () => {
    const added = violation({ element: "#new-banner", severity: 1 });
    const comparison = compare([worse(), added], [violation()]);

    expect(gateableMeasurements(comparison)).toEqual([added, worse()]);
    expect(comparison.introduced).not.toContain(worse());
    expect(comparison.worsened).not.toContain(added);
  });

  it("agrees with itself across the two published surfaces", () => {
    const decision = decideDelivery(
      { status: "completed", result: withMeasurements([worse()]) },
      {
        headSha: "head",
        gate: "none",
        measurements: "block",
        measurementBaseline: found(baselineOf([violation()])),
      },
    );

    expect(decision.checkRun.conclusion).toBe("failure");
    expect(decision.worsenedMeasurementKinds).toEqual(["contrast"]);
    expect(decision.introducedMeasurementKinds).toEqual([]);
    expect(saysAlreadyHereAndWorse(decision.comment ?? "")).toBe(true);
    expect(saysAlreadyHereAndWorse(decision.checkRun.summary)).toBe(true);
  });
});

/* -------------------------------------------------------------- saying it */

describe("the surfaces keep 'new' and 'made worse' apart", () => {
  const comparison = compare([worse()], [violation()]);
  const rendered = sectionFor(comparison, "block");

  it("says the violation was already here AND that this pull request made it worse", () => {
    expect(saysAlreadyHereAndWorse(rendered)).toBe(true);
  });

  it("does not fold it into the introduced count", () => {
    expect(comparison.introduced).toEqual([]);
    const heading = rendered.split("\n\n")[0] ?? "";
    expect(heading).toContain("0 introduced by this pull request");
    expect(WORSE_WORD.test(heading)).toBe(true);
  });

  it("stops claiming nothing above is new in the all-clear voice", () => {
    // "No measured violation above is new" is true of a worsened violation and
    // reads as an all-clear next to a red check. The unworsened carry-over still
    // gets it, which is what makes this assertion mean something.
    expect(claimsNothingIsNew(rendered)).toBe(false);
    expect(claimsNothingIsNew(sectionFor(compare([violation()], [violation()])))).toBe(true);
  });

  it("stops promising that everything already on the base never fails a check", () => {
    // That promise is false the moment one of them gated, and it is the one
    // sentence on this surface that would contradict the red check beside it.
    const paragraphOf = (section: string): string =>
      section.split("\n\n").find((part) => part.includes("**Already on the base**")) ?? "";
    const worsenedParagraph = paragraphOf(rendered);
    expect(worsenedParagraph).not.toBe("");

    // Any promise that these never fail has to be scoped to the ones that did
    // not, rather than made about all of them.
    for (const sentence of sentencesOf(worsenedParagraph)) {
      if (/\bnever\b/i.test(sentence) && /\bfail/i.test(sentence)) {
        expect(sentence).toMatch(/\b(rest|other|others|except|unless)\b/i);
      }
    }
    // ...and the paragraph says out loud that a worsened one can fail, so the
    // loop above cannot be satisfied by a paragraph that says nothing at all.
    expect(
      sentencesOf(worsenedParagraph).some(
        (sentence) => WORSE_WORD.test(sentence) && /\bfail/i.test(sentence),
      ),
    ).toBe(true);

    // The differential: with nothing worsened the promise is true, and is still
    // made, so the assertions above are a change of claim and not a deletion.
    const quiet = paragraphOf(sectionFor(compare([violation()], [violation()]), "block"));
    expect(
      sentencesOf(quiet).some((sentence) => /\bnever\b/i.test(sentence) && /\bfail/i.test(sentence)),
    ).toBe(true);
  });

  it("puts the band before and after on the row, and never a magnitude", () => {
    expect(rendered).toContain("severity band 2");
    expect(rendered).toContain("3");
    // The engine's measured numbers never reach Gate, so they can never reach
    // this surface from the stored side. The base ratio is nowhere on the page.
    expect(rendered).not.toContain("2.91:1");
  });

  it("names it on the Check Run summary when it is what failed the check", () => {
    const run = buildCheckRun(withMeasurements([worse()]), "none", {
      measurements: "block",
      baseline: comparison,
    });
    const headline = run.summary.split("\n\n")[0] ?? "";

    expect(run.conclusion).toBe("failure");
    expect(headline).toContain("Failed by measurement");
    expect(WORSE_WORD.test(headline)).toBe(true);
    // The count is the gating set, not the back catalogue and not the
    // introduced count, which here is zero.
    expect(Number(/\d+/.exec(headline)?.[0] ?? -1)).toBe(gateableMeasurements(comparison).length);
  });

  it("keeps both counts and both sentences when a pull request does both", () => {
    const added = violation({ element: "#new-banner", severity: 1 });
    const both = compare([worse(), added], [violation()]);
    const run = buildCheckRun(withMeasurements([worse(), added]), "none", {
      measurements: "block",
      baseline: both,
    });
    const headline = run.summary.split("\n\n")[0] ?? "";
    const section = sectionFor(both, "block");

    expect(Number(/\d+/.exec(headline)?.[0] ?? -1)).toBe(2);
    expect(headline).toMatch(/\b1 of them is new here\b/);
    expect(section).toContain("**New in this pull request**");
    expect(saysAlreadyHereAndWorse(section)).toBe(true);
  });

  it("renders nothing at all under off, worsened or not", () => {
    expect(baselineSection(comparison, { mode: "off" })).toBeNull();
  });
});
