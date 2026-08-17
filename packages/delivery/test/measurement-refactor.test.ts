import { loadGoldenReviewResult, type GateReviewResult, type Measurement } from "@gate/types";
import { describe, expect, it } from "vitest";
import {
  buildCheckRun,
  buildMeasurementBaseline,
  compareMeasurementsToBaseline,
  gateableMeasurements,
  measurementDefectKey,
  type ClassifiedMeasurement,
  type MeasurementComparison,
} from "../src/index.js";

/**
 * A MARKUP REFACTOR MUST NOT MANUFACTURE A MERGE BLOCKER.
 *
 * Measurement identity already absorbs the things that move a selector without
 * moving the defect underneath it: a sibling inserted above, a `:first-child`
 * respelled as `nth-child`, whitespace, a trailing slash, a ratio that drifts by
 * a hundredth, an engine that rewords its own sentence. It did not absorb the
 * things that move the selector PATH, and there are three of them:
 *
 *     #hero .tagline  ->  #hero > .tagline        a combinator was tightened
 *     #hero .tagline  ->  #hero .inner .tagline   a wrapper div was added
 *     #hero .tagline  ->  #hero .subtitle         the class was renamed
 *
 * Each read as one violation resolved plus one introduced, and under
 * `rules.measurements: block` that fails a pull request which changed no colour
 * at all. Markup refactors around old markup are routine on exactly the mature
 * repositories a baseline is for, so this was the install-day flood the baseline
 * was built to prevent, moved to refactor day. The only way out was
 * `measurement_suppress`, which mutes by kind or element and would have hidden
 * the real defect with it.
 *
 * These tests are the whole matrix, one change at a time against one fixed
 * baseline, plus the half that this fix could plausibly break: a genuinely new
 * violation on a genuinely new element still has to come out INTRODUCED. Every
 * row asserts the classification AND what it does to a check run under `block`,
 * because the classification is only interesting for what it gates.
 */

const CONTRAST_DETAIL = "text contrast 2.91:1 is below WCAG AA 4.5:1";

/** The violation every row refactors, on the site root. */
const TAGLINE: Measurement = {
  kind: "contrast",
  route: "/",
  viewports: ["mobile"],
  element: "#hero ul li:nth-child(3) .tagline",
  detail: CONTRAST_DETAIL,
  blockEligible: true,
};

/** A second, unrelated violation on a second page. Nothing in the matrix touches it. */
const GRID: Measurement = {
  kind: "overflow",
  route: "/pricing",
  viewports: ["mobile"],
  element: "#plans .grid",
  detail: "element is 412px wide inside a 390px viewport",
  blockEligible: true,
};

const ALL_ROUTES = ["/", "/pricing"];

function runOf(violations: Measurement[], routes: string[] = ALL_ROUTES): GateReviewResult {
  return {
    ...loadGoldenReviewResult(),
    measurements: { checksRun: ["contrast", "overflow", "touch_target"], violations },
    coverage: {
      routesRequested: routes,
      routesReviewed: routes,
      viewportsRequested: ["mobile"],
      viewportsReviewed: ["mobile"],
    },
  };
}

/** The one fixed base commit the whole matrix is compared against. */
const BASELINE = buildMeasurementBaseline(runOf([TAGLINE, GRID]), { commitSha: "basesha0000" });

function compare(violations: Measurement[], routes: string[] = ALL_ROUTES): MeasurementComparison {
  return compareMeasurementsToBaseline(runOf(violations, routes), {
    lookup: { status: "found", snapshot: BASELINE },
  });
}

/** Whether `rules.measurements: block` would fail the check on this comparison. */
function blocks(comparison: MeasurementComparison, violations: Measurement[], routes = ALL_ROUTES): boolean {
  return (
    buildCheckRun(runOf(violations, routes), "none", {
      measurements: "block",
      baseline: comparison,
    }).conclusion === "failure"
  );
}

/** The row a given violation was placed into. */
function rowFor(comparison: MeasurementComparison, element: string): ClassifiedMeasurement {
  const row = comparison.classified.find((entry) => entry.measurement.element === element);
  if (!row) throw new Error(`no classified row for ${element}`);
  return row;
}

/** One change at a time: the tagline violation, edited, plus the untouched grid one. */
function refactored(over: Partial<Measurement>): Measurement[] {
  return [{ ...TAGLINE, ...over }, GRID];
}

describe("the six things identity already absorbed stay absorbed", () => {
  const rows: Array<[string, Partial<Measurement>]> = [
    ["an untouched control", {}],
    ["a sibling inserted above it", { element: "#hero ul li:nth-child(5) .tagline" }],
    ["extra whitespace in the selector", { element: "#hero  ul   li:nth-child(3)   .tagline" }],
    ["a trailing slash on the route", { route: "//" }],
    ["a ratio that drifted 2.91 -> 2.87", { detail: "text contrast 2.87:1 is below WCAG AA 4.5:1" }],
    ["the engine rewording its own sentence", { detail: "contrast is under the WCAG AA minimum" }],
  ];

  for (const [name, change] of rows) {
    it(`is pre-existing after ${name}`, () => {
      const violations = refactored(change);
      const comparison = compare(violations);

      expect(comparison.introduced).toEqual([]);
      expect(comparison.preExisting).toHaveLength(2);
      expect(comparison.resolved).toBe(0);
      expect(blocks(comparison, violations)).toBe(false);
    });
  }

  it("does not reach the refactor tier for any of them", () => {
    // The six are absorbed by the exact keys, which is stronger than a claim and
    // must stay that way: only the last of them is even a detail change.
    for (const [, change] of rows) {
      const row = rowFor(compare(refactored(change)), { ...TAGLINE, ...change }.element);
      expect(row.elementChanged).toBeUndefined();
    }
  });
});

describe("the three selector-path changes are absorbed too", () => {
  const rows: Array<[string, string]> = [
    ["a descendant combinator was tightened to a child one", "#hero ul li:nth-child(3) > .tagline"],
    ["a wrapper div was added", "#hero ul li:nth-child(3) .inner .tagline"],
    ["the class was renamed", "#hero ul li:nth-child(3) .subtitle"],
  ];

  for (const [name, element] of rows) {
    it(`is pre-existing when ${name}`, () => {
      const violations = refactored({ element });
      const comparison = compare(violations);
      const row = rowFor(comparison, element);

      expect(row.origin).toBe("pre_existing");
      // Marked as what it is: the same defect, carried by different markup.
      expect(row.elementChanged).toBe(true);
      expect(comparison.introduced).toEqual([]);
      // ...and it is NOT also counted as a fix. One defect, one row, one place.
      expect(comparison.resolved).toBe(0);
      expect(blocks(comparison, violations)).toBe(false);
    });
  }

  it("says on the pull request which of the two kinds of carry-over it is", () => {
    const violations = refactored({ element: "#hero ul li:nth-child(3) .inner .tagline" });
    const summary = buildCheckRun(runOf(violations), "none", {
      measurements: "block",
      baseline: compare(violations),
    }).summary;

    expect(summary).toContain("carried by a different selector");
    expect(summary).toContain("0 introduced by this pull request");
  });
});

describe("a renamed route is unclassified, deliberately", () => {
  // The route is the last coordinate that keeps two pages apart. A defect key
  // with a fuzzy route would let a genuinely new page inherit an old page's
  // clean bill of health in silence, which is the failure nobody sees. So `/`
  // becoming `/home` is not absorbed, and both halves of that are asserted here.
  const moved = { ...TAGLINE, route: "/home" };
  const violations = [moved, GRID];
  const routes = ["/home", "/pricing"];
  const comparison = compare(violations, routes);

  it("is reported, named, and never gates", () => {
    const row = rowFor(comparison, moved.element);
    expect(row.origin).toBe("unclassified");
    expect(row.reason).toBe("route_not_measured");
    expect(comparison.introduced).toEqual([]);
    expect(gateableMeasurements(comparison)).toEqual([]);
    expect(blocks(comparison, violations, routes)).toBe(false);
  });

  it("does not let the old page's violation masquerade as a fix", () => {
    // `/` was not captured by this run, and a page nobody looked at was not
    // fixed. Counting it would turn a rename into a green "1 violation gone".
    expect(comparison.resolved).toBe(0);
  });

  it("says so on the pull request, as a route the base never captured", () => {
    const summary = buildCheckRun(runOf(violations, routes), "none", {
      measurements: "block",
      baseline: comparison,
    }).summary;

    expect(summary).toContain("the base run never captured that route, new or renamed");
    expect(summary).toContain("Not classified");
  });
});

describe("a genuinely new violation is still introduced", () => {
  // The half this fix could break. The defect key drops the selector, so the
  // only thing standing between "a refactor is absorbed" and "everything is
  // absorbed" is that a claim spends a baseline entry nothing else accounts for.

  const NEW_BANNER: Measurement = {
    kind: "contrast",
    route: "/",
    viewports: ["mobile"],
    element: "#promo .badge",
    // WORD FOR WORD the sentence the old violation carries, magnitudes and all,
    // on the same route and the same check. Nothing but the count separates it
    // from the pre-existing one.
    detail: CONTRAST_DETAIL,
    blockEligible: true,
  };

  it("is introduced when the old violation is still there, sentence for sentence", () => {
    expect(measurementDefectKey(NEW_BANNER)).toBe(measurementDefectKey(TAGLINE));

    const violations = [TAGLINE, GRID, NEW_BANNER];
    const comparison = compare(violations);

    expect(comparison.introduced).toEqual([NEW_BANNER]);
    expect(comparison.preExisting).toEqual([TAGLINE, GRID]);
    expect(blocks(comparison, violations)).toBe(true);
  });

  it("is introduced even when the old violation was refactored in the same push", () => {
    // A wrapper around the old defect AND a new one, in one pull request. The
    // refactor claims the entry it is entitled to and the new violation finds
    // nothing left to claim.
    const wrapped = { ...TAGLINE, element: "#hero ul li:nth-child(3) .inner .tagline" };
    const violations = [wrapped, GRID, NEW_BANNER];
    const comparison = compare(violations);

    expect(rowFor(comparison, wrapped.element).elementChanged).toBe(true);
    expect(comparison.introduced).toEqual([NEW_BANNER]);
    expect(blocks(comparison, violations)).toBe(true);
  });

  it("is introduced when it states a different defect on the same page", () => {
    const different = { ...NEW_BANNER, detail: "text is placed over a background image" };
    const violations = [TAGLINE, GRID, different];

    expect(compare(violations).introduced).toEqual([different]);
    expect(blocks(compare(violations), violations)).toBe(true);
  });

  it("is introduced on a page the base measured clean, however familiar it sounds", () => {
    // Same check, same sentence, a route the base run DID capture and found
    // nothing of the kind on. The defect key is per route for this reason.
    const elsewhere = { ...NEW_BANNER, route: "/pricing", element: "#plans .note" };
    const violations = [TAGLINE, GRID, elsewhere];

    expect(compare(violations).introduced).toEqual([elsewhere]);
    expect(blocks(compare(violations), violations)).toBe(true);
  });

  it("is introduced when a second copy of the same defect appears on the same page", () => {
    // Two refactored selectors where the base had one violation. One of them can
    // claim the entry; the second cannot, and the count is what catches it.
    const first = { ...TAGLINE, element: "#hero .col-a .tagline" };
    const second = { ...TAGLINE, element: "#hero .col-b .tagline" };
    const violations = [first, second, GRID];
    const comparison = compare(violations);

    expect(comparison.introduced).toHaveLength(1);
    expect(comparison.preExisting).toHaveLength(2);
    expect(blocks(comparison, violations)).toBe(true);
  });

  it("cannot claim an entry a muted violation is still sitting on", () => {
    // `measurement_suppress` hides a violation, it does not fix it. The muted
    // one still accounts for its baseline entry, so the new one finds nothing.
    const violations = [TAGLINE, GRID, NEW_BANNER];
    const comparison = compareMeasurementsToBaseline(runOf(violations), {
      lookup: { status: "found", snapshot: BASELINE },
      suppress: ["contrast:#hero ul li:nth-child(3) .tagline"],
    });

    expect(comparison.preExisting).toEqual([GRID]);
    expect(comparison.introduced).toEqual([NEW_BANNER]);
    expect(comparison.resolved).toBe(0);
  });
});

describe("what the refactor tier costs, stated rather than hidden", () => {
  it("carries a violation over when one defect was fixed and a like one added", () => {
    // The known false "already there". A pull request that deletes the old
    // low-contrast element and adds a different one with the same sentence on
    // the same page reads as carried over, not as introduced.
    //
    // This is the cheaper of the two errors and it is chosen knowingly: a false
    // "already there" is a violation Gate still renders, still counts and still
    // shows the reader, while a false "introduced" is a red check on unrelated
    // work whose only escape hatch also hides real defects. It is asserted here
    // so the cost is a decision on the record rather than a surprise.
    const replacement = { ...TAGLINE, element: "#footer .legal" };
    const violations = [replacement, GRID];
    const comparison = compare(violations);

    expect(rowFor(comparison, replacement.element).origin).toBe("pre_existing");
    expect(comparison.introduced).toEqual([]);
    expect(comparison.resolved).toBe(0);
  });

  it("still refuses to claim across a check, a page or a sentence", () => {
    // The three signals the claim is built from. Change any one of them and the
    // violation is introduced, which is what keeps the tier from becoming "match
    // anything on this repository".
    const cases: Measurement[] = [
      { ...TAGLINE, kind: "touch_target", element: "#hero .other" },
      { ...TAGLINE, route: "/pricing", element: "#hero .other" },
      { ...TAGLINE, detail: "text is placed over a background image", element: "#hero .other" },
    ];

    for (const only of cases) {
      // The old violation is GONE in each of these, so its entry is unclaimed
      // and free. The claim is refused anyway, on the one signal that changed.
      const comparison = compare([only, GRID]);
      expect(comparison.introduced).toEqual([only]);
      expect(comparison.resolved).toBe(1);
    }
  });
});

describe("a real fix is still a fix", () => {
  it("counts the violation as gone when nothing claims its entry", () => {
    const comparison = compare([GRID]);

    expect(comparison.resolved).toBe(1);
    expect(comparison.introduced).toEqual([]);
    expect(comparison.preExisting).toEqual([GRID]);
  });
});
