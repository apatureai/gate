import {
  loadGoldenReviewResult,
  loadMeasuredReviewResult,
  type GateReviewResult,
  type Measurement,
} from "@gate/types";
import { describe, expect, it } from "vitest";
import {
  baselineSection,
  buildCheckRun,
  buildMeasurementBaseline,
  compareMeasurementsToBaseline,
  createInMemoryMeasurementBaselineStore,
  decideDelivery,
  gateableMeasurements,
  lookupMeasurementBaseline,
  mapCheckRunConclusion,
  measurementElementKey,
  measurementFingerprint,
  measurementIdentity,
  measuredKinds,
  measuredRoutes,
  normalizeElement,
  normalizeRoute,
  renderStickyComment,
  type MeasurementBaselineLookup,
  type MeasurementBaselineSnapshot,
} from "../src/index.js";

/**
 * The measured half, scoped to what THIS pull request introduced.
 *
 * Every run reported every violation on every page it captured. As advisory
 * output that is noise; as a merge gate it is the thing that gets the tool
 * switched off, because the first pull request after installation inherits the
 * repository's whole back catalogue. These tests are the boundary around the
 * fix, and most of them are about the case where the fix has nothing to say: no
 * stored baseline must never gate, and must never read like a clean result.
 */

const violation = (over: Partial<Measurement> = {}): Measurement => ({
  kind: "contrast",
  route: "/pricing",
  viewports: ["mobile"],
  element: "#hero-subtitle",
  detail: "text contrast 3.23:1 is below WCAG AA 4.5:1",
  blockEligible: true,
  ...over,
});

const withMeasurements = (violations: Measurement[], over: Partial<GateReviewResult> = {}): GateReviewResult => ({
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

/** A baseline recorded from a base run that measured `violations` on /pricing + /checkout. */
const baselineOf = (violations: Measurement[], commitSha = "basesha0000"): MeasurementBaselineSnapshot =>
  buildMeasurementBaseline(withMeasurements(violations), { commitSha });

const found = (snapshot: MeasurementBaselineSnapshot): MeasurementBaselineLookup => ({
  status: "found",
  snapshot,
});

describe("measurement identity", () => {
  it("survives a sibling being inserted above the defect", () => {
    // THE case the whole feature turns on. `nth-child` moves when a pull request
    // adds an element somewhere above; the defect does not.
    const before = violation({ element: "main > ul > li:nth-child(3) > a.cta" });
    const after = violation({ element: "main > ul > li:nth-child(4) > a.cta" });

    expect(measurementFingerprint(after)).toBe(measurementFingerprint(before));
    expect(measurementElementKey(after)).toBe(measurementElementKey(before));
  });

  it("treats :first-child and its nth-child spelling as the same place", () => {
    const before = violation({ element: "main > p:first-child" });
    const after = violation({ element: "main > p:nth-child(2)" });
    expect(measurementFingerprint(after)).toBe(measurementFingerprint(before));
  });

  it("ignores combinator spacing and a trailing slash on the route", () => {
    const before = violation({ route: "/pricing/", element: "div>span.price" });
    const after = violation({ route: "/pricing", element: "div > span.price" });
    expect(measurementFingerprint(after)).toBe(measurementFingerprint(before));
    expect(normalizeRoute("/pricing/")).toBe("/pricing");
    expect(normalizeElement("div>span.price")).toBe("div > span.price");
  });

  it("ignores a drifting magnitude but not a different statement", () => {
    // A contrast ratio that slips by a hundredth is one defect measured twice.
    const drifted = violation({ detail: "text contrast 3.19:1 is below WCAG AA 4.5:1" });
    expect(measurementFingerprint(drifted)).toBe(measurementFingerprint(violation()));

    const different = violation({ detail: "text is placed over a background image" });
    expect(measurementFingerprint(different)).not.toBe(measurementFingerprint(violation()));
    // ...and the coarse key still recognises it as the same element, which is
    // what keeps a reworded engine from inventing a repository of new defects.
    expect(measurementElementKey(different)).toBe(measurementElementKey(violation()));
  });

  it("separates two different elements, routes and checks", () => {
    expect(measurementFingerprint(violation({ element: "#other" }))).not.toBe(
      measurementFingerprint(violation()),
    );
    expect(measurementFingerprint(violation({ route: "/checkout" }))).not.toBe(
      measurementFingerprint(violation()),
    );
    expect(measurementFingerprint(violation({ kind: "overflow" }))).not.toBe(
      measurementFingerprint(violation()),
    );
  });

  it("keeps the viewport set and the engine's eligibility flag out of the key", () => {
    // Both move for reasons that are not the defect: viewports follow the repo's
    // config, `blockEligible` follows the ENGINE's version.
    expect(measurementFingerprint(violation({ viewports: ["mobile", "desktop"] }))).toBe(
      measurementFingerprint(violation()),
    );
    expect(measurementFingerprint(violation({ blockEligible: false }))).toBe(
      measurementFingerprint(violation()),
    );
  });

  it("stamps the normalization version it was computed under", () => {
    expect(measurementFingerprint(violation()).startsWith("m1:")).toBe(true);
    expect(measurementIdentity(violation()).detail).toBe(
      "text contrast #:# is below wcag aa #:#",
    );
  });
});

describe("what a baseline records", () => {
  it("records the checks and routes it can prove, not the ones it hopes for", () => {
    const result = withMeasurements([violation({ route: "/pricing" })]);
    const snapshot = buildMeasurementBaseline(result, { commitSha: "abc" });

    expect(snapshot.routesMeasured).toEqual(["/checkout", "/pricing"]);
    expect(snapshot.checksRun).toEqual(["contrast", "overflow", "touch_target"]);
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.version).toBe("m1");
  });

  it("records nothing measurable from a result that carries no measurement report", () => {
    // Full coverage and a real grade, and NOT ONE deterministic check. Reading
    // this as a clean base is exactly the mistake that fails somebody's first PR.
    const golden = loadGoldenReviewResult();
    expect(measuredRoutes(golden)).toEqual([]);
    expect(measuredKinds(golden)).toEqual([]);
    expect(buildMeasurementBaseline(golden, { commitSha: "abc" }).routesMeasured).toEqual([]);
  });

  it("takes a violation as proof its route and check ran, whatever the report claims", () => {
    const understated: GateReviewResult = {
      ...withMeasurements([violation({ route: "/undeclared" })]),
      measurements: { checksRun: [], violations: [violation({ route: "/undeclared" })] },
    };
    expect(measuredKinds(understated)).toEqual(["contrast"]);
    expect(measuredRoutes(understated)).toContain("/undeclared");
  });

  it("records the unsuppressed set, so lifting a mute does not invent new violations", () => {
    const result = withMeasurements([violation(), violation({ kind: "overflow", element: "#promo" })]);
    // `measurement_suppress` is a rendering choice a repo can change between two
    // runs; a baseline that moved with it would report old violations as new.
    expect(buildMeasurementBaseline(result, { commitSha: "abc" }).entries).toHaveLength(2);
  });
});

describe("no baseline", () => {
  const result = withMeasurements([violation()]);

  it("classifies nothing, gates nothing, and says which of those it is", () => {
    const comparison = compareMeasurementsToBaseline(result, {
      lookup: { status: "absent", baseSha: "basesha0000" },
    });

    expect(comparison.status).toBe("no_baseline");
    expect(comparison.introduced).toEqual([]);
    expect(comparison.unclassified).toHaveLength(1);
    expect(comparison.classified[0]?.reason).toBe("no_baseline");
    expect(gateableMeasurements(comparison)).toEqual([]);
  });

  it("cannot fail a check even when the repo asked for block", () => {
    const run = buildCheckRun(result, "none", {
      measurements: "block",
      baseline: compareMeasurementsToBaseline(result, {
        lookup: { status: "absent", baseSha: "basesha0000" },
      }),
    });

    expect(run.conclusion).not.toBe("failure");
    expect(run.conclusion).toBe(mapCheckRunConclusion(result.grade, "none"));
  });

  it("does not read like 'no new violations'", () => {
    // The honesty requirement, stated as a test: these are opposite claims and
    // they must not render alike.
    const noBaseline = buildCheckRun(result, "none", {
      baseline: compareMeasurementsToBaseline(result, {
        lookup: { status: "absent", baseSha: "basesha0000" },
      }),
    }).summary;
    const cleanBase = buildCheckRun(result, "none", {
      baseline: compareMeasurementsToBaseline(result, { lookup: found(baselineOf([])) }),
    }).summary;

    expect(noBaseline).toContain("no baseline");
    expect(noBaseline).toContain("Gate has never recorded a measurement set");
    expect(noBaseline).not.toContain("introduced by this pull request**");
    expect(cleanBase).toContain("1 introduced by this pull request");
    expect(cleanBase).not.toContain("no baseline");
  });

  it("names the reason when Gate could not look at all", () => {
    const comparison = compareMeasurementsToBaseline(result, {
      lookup: { status: "unavailable", baseSha: "basesha0000", detail: "no baseline store is configured" },
    });
    const summary = buildCheckRun(result, "none", { measurements: "block", baseline: comparison }).summary;

    expect(comparison.status).toBe("unavailable");
    expect(summary).toContain("could not read a stored measurement set");
    expect(summary).toContain("no baseline store is configured");
    // ...and says the repo's own setting is doing nothing on this run.
    expect(summary).toContain("that setting is doing nothing on this run");
  });

  it("refuses a baseline recorded under a different identity version", () => {
    const stale: MeasurementBaselineSnapshot = { ...baselineOf([violation()]), version: "m0" };
    const comparison = compareMeasurementsToBaseline(result, { lookup: found(stale) });

    expect(comparison.status).toBe("version_skew");
    expect(comparison.introduced).toEqual([]);
    expect(comparison.classified[0]?.reason).toBe("version_skew");
    const summary = buildCheckRun(result, "none", { measurements: "block", baseline: comparison }).summary;
    expect(summary).toContain("`m0`");
    expect(summary).toContain("cannot be compared");
  });
});

describe("an empty baseline is not an absent one", () => {
  const result = withMeasurements([violation()]);
  const comparison = compareMeasurementsToBaseline(result, { lookup: found(baselineOf([])) });

  it("makes a violation genuinely new", () => {
    expect(comparison.status).toBe("compared");
    expect(comparison.baselineSize).toBe(0);
    expect(comparison.introduced).toHaveLength(1);
  });

  it("gates under block, where an absent baseline could not", () => {
    const run = buildCheckRun(result, "none", { measurements: "block", baseline: comparison });
    expect(run.conclusion).toBe("failure");
    expect(run.title).toBe("Measured violations");
    expect(run.summary).toContain("introduced by this pull request");
  });

  it("still refuses to gate on an engine-marked inconclusive violation", () => {
    // The baseline decides WHOSE violation it is. The engine still decides
    // whether it is precise enough to fail a build on, and neither overrides it.
    const inconclusive = withMeasurements([violation({ blockEligible: false })]);
    const run = buildCheckRun(inconclusive, "none", {
      measurements: "block",
      baseline: compareMeasurementsToBaseline(inconclusive, { lookup: found(baselineOf([])) }),
    });
    expect(run.conclusion).not.toBe("failure");
  });
});

describe("a pre-existing violation", () => {
  const carried = violation();
  const result = withMeasurements([carried]);
  const comparison = compareMeasurementsToBaseline(result, { lookup: found(baselineOf([carried])) });

  it("is reported, marked, and never gates", () => {
    expect(comparison.preExisting).toHaveLength(1);
    expect(comparison.introduced).toEqual([]);

    const run = buildCheckRun(result, "none", { measurements: "block", baseline: comparison });
    expect(run.conclusion).not.toBe("failure");
    expect(run.summary).toContain("#hero-subtitle"); // still reported
    expect(run.summary).toContain("Already on the base");
    expect(run.summary).toContain("0 introduced by this pull request");
  });

  it("stays pre-existing when the line moves and the defect does not", () => {
    // The named case: same defect, new position, new measurement.
    const moved = violation({
      element: "main > ul > li:nth-child(9) > #hero-subtitle",
      detail: "text contrast 3.19:1 is below WCAG AA 4.5:1",
    });
    const base = violation({ element: "main > ul > li:nth-child(2) > #hero-subtitle" });
    const movedResult = withMeasurements([moved]);
    const moveComparison = compareMeasurementsToBaseline(movedResult, {
      lookup: found(baselineOf([base])),
    });

    expect(moveComparison.introduced).toEqual([]);
    expect(moveComparison.preExisting).toHaveLength(1);
  });

  it("is still pre-existing when only the engine's wording changed", () => {
    const reworded = violation({ detail: "contrast ratio below the WCAG AA threshold" });
    const rewordedResult = withMeasurements([reworded]);
    const rewordComparison = compareMeasurementsToBaseline(rewordedResult, {
      lookup: found(baselineOf([violation()])),
    });

    expect(rewordComparison.introduced).toEqual([]);
    expect(rewordComparison.classified[0]?.detailChanged).toBe(true);
    expect(
      buildCheckRun(rewordedResult, "none", {
        measurements: "block",
        baseline: rewordComparison,
      }).conclusion,
    ).not.toBe("failure");
  });
});

describe("an introduced violation", () => {
  const carried = violation();
  const added = violation({ element: "#new-banner", detail: "text contrast 2.10:1 is below WCAG AA 4.5:1" });
  const result = withMeasurements([carried, added]);
  const comparison = compareMeasurementsToBaseline(result, { lookup: found(baselineOf([carried])) });

  it("is the only one that gates, and is named", () => {
    expect(comparison.introduced).toEqual([added]);
    expect(comparison.preExisting).toEqual([carried]);

    const run = buildCheckRun(result, "none", { measurements: "block", baseline: comparison });
    expect(run.conclusion).toBe("failure");
    expect(run.summary).toContain("1 block-eligible measurement(s) introduced by this pull request");
    expect(run.summary).toContain("New in this pull request");
    expect(run.summary).toContain("#new-banner");
  });

  it("gates nothing under advisory, and the block says so in the repo's own words", () => {
    const run = buildCheckRun(result, "none", { measurements: "advisory", baseline: comparison });
    expect(run.conclusion).toBe(mapCheckRunConclusion(result.grade, "none"));
    expect(run.summary).toContain("1 introduced by this pull request");
  });

  it("stops gating once the repo mutes it", () => {
    const muted = compareMeasurementsToBaseline(result, {
      lookup: found(baselineOf([carried])),
      suppress: ["#new-banner"],
    });
    expect(muted.introduced).toEqual([]);
    expect(
      buildCheckRun(result, "none", {
        measurements: "block",
        measurementSuppress: ["#new-banner"],
        baseline: muted,
      }).conclusion,
    ).not.toBe("failure");
  });
});

describe("a fixed violation", () => {
  it("is counted as gone, on the routes and checks this run measured", () => {
    const gone = violation({ element: "#was-broken" });
    const result = withMeasurements([]);
    const comparison = compareMeasurementsToBaseline(result, { lookup: found(baselineOf([gone])) });

    expect(comparison.resolved).toBe(1);
    expect(comparison.introduced).toEqual([]);
    expect(
      buildCheckRun(result, "none", { baseline: comparison }).summary,
    ).toContain("1 violation(s) recorded on the base are gone");
  });

  it("is not counted when this run never captured its route", () => {
    // A page nobody looked at is not a page that was fixed.
    const elsewhere = violation({ route: "/admin", element: "#admin-banner" });
    const baseResult: GateReviewResult = {
      ...withMeasurements([elsewhere]),
      coverage: {
        routesRequested: ["/admin"],
        routesReviewed: ["/admin"],
        viewportsRequested: ["mobile"],
        viewportsReviewed: ["mobile"],
      },
    };
    const base = buildMeasurementBaseline(baseResult, { commitSha: "basesha0000" });
    const now = withMeasurements([]); // covered /pricing + /checkout, never /admin

    expect(compareMeasurementsToBaseline(now, { lookup: found(base) }).resolved).toBe(0);
  });

  it("is not counted when the repo merely muted it", () => {
    const muted = violation({ element: "#muted" });
    const result = withMeasurements([muted]);
    const comparison = compareMeasurementsToBaseline(result, {
      lookup: found(baselineOf([muted])),
      suppress: ["#muted"],
    });

    expect(comparison.resolved).toBe(0);
  });
});

describe("what the base run never looked at", () => {
  it("is unclassified rather than guessed, and never gates", () => {
    const onNewRoute = violation({ route: "/brand-new", element: "#hero" });
    const result = withMeasurements([onNewRoute], {
      coverage: {
        routesRequested: ["/brand-new"],
        routesReviewed: ["/brand-new"],
        viewportsRequested: ["mobile"],
        viewportsReviewed: ["mobile"],
      },
    });
    const comparison = compareMeasurementsToBaseline(result, { lookup: found(baselineOf([])) });

    expect(comparison.introduced).toEqual([]);
    expect(comparison.classified[0]?.reason).toBe("route_not_measured");
    const run = buildCheckRun(result, "none", { measurements: "block", baseline: comparison });
    expect(run.conclusion).not.toBe("failure");
    expect(run.summary).toContain("the base run never captured that route");
  });

  it("is unclassified when the base ran a different set of checks", () => {
    const base: MeasurementBaselineSnapshot = { ...baselineOf([]), checksRun: ["contrast"] };
    const result = withMeasurements([violation({ kind: "overflow", element: "#wide" })]);
    const comparison = compareMeasurementsToBaseline(result, { lookup: found(base) });

    expect(comparison.introduced).toEqual([]);
    expect(comparison.classified[0]?.reason).toBe("check_not_run");
    expect(
      buildCheckRun(result, "none", { measurements: "block", baseline: comparison }).conclusion,
    ).not.toBe("failure");
  });
});

describe("the two surfaces agree", () => {
  const added = violation({ element: "#new-banner" });
  const result = withMeasurements([violation(), added]);
  const lookup = found(baselineOf([violation()]));

  it("puts the same scoping on the comment as on the check", () => {
    const decision = decideDelivery(
      { status: "completed", result },
      { headSha: "head", gate: "none", measurements: "block", measurementBaseline: lookup },
    );

    expect(decision.checkRun.conclusion).toBe("failure");
    expect(decision.measurementBaseline).toBe("compared");
    expect(decision.introducedMeasurementKinds).toEqual(["contrast"]);
    expect(decision.comment).toContain("New in this pull request");
    expect(decision.comment).toContain("#new-banner");
    expect(decision.checkRun.summary).toContain("New in this pull request");
  });

  it("carries the no-baseline disclosure onto both of them", () => {
    const decision = decideDelivery(
      { status: "completed", result },
      {
        headSha: "head",
        gate: "none",
        measurements: "block",
        measurementBaseline: { status: "absent", baseSha: "basesha0000" },
      },
    );

    expect(decision.checkRun.conclusion).not.toBe("failure");
    expect(decision.measurementBaseline).toBe("no_baseline");
    expect(decision.comment).toContain("no baseline");
    expect(decision.checkRun.summary).toContain("no baseline");
  });

  it("renders exactly as before when the caller asked for no scoping", () => {
    // The Action path and every existing caller: absence of the field is not the
    // same as an absent baseline, and must not change a single published byte.
    const unscoped = decideDelivery(
      { status: "completed", result },
      { headSha: "head", gate: "none", measurements: "advisory" },
    );

    expect(unscoped.measurementBaseline).toBeUndefined();
    expect(unscoped.comment).not.toContain("Scoped to this pull request");
    expect(unscoped.checkRun.summary).not.toContain("Scoped to this pull request");
  });

  it("neutralizes markdown in a route it prints back in the scoped section", () => {
    // The routes in this section come off the engine, like every other cell.
    const nasty = violation({ route: "/x\n## Apature Gate: design review", element: "#h" });
    const nastyResult = withMeasurements([nasty], {
      coverage: {
        routesRequested: ["/x"],
        routesReviewed: ["/x"],
        viewportsRequested: ["mobile"],
        viewportsReviewed: ["mobile"],
      },
    });
    const comparison = compareMeasurementsToBaseline(nastyResult, { lookup: found(baselineOf([])) });
    const section = baselineSection(comparison) ?? "";
    const comment = renderStickyComment(nastyResult, { headSha: "head", baseline: comparison });

    expect(section).toContain("Not classified");
    expect(section).not.toContain("\n## Apature Gate");
    expect(comment).toContain(section);
  });

  it("says nothing new is new only about the violations it could place", () => {
    // An unclassified violation is not evidence that this pull request added
    // nothing, and the section must not borrow it as if it were.
    const unplaceable = violation({ route: "/brand-new", element: "#hero" });
    const mixed = withMeasurements([violation(), unplaceable]);
    const comparison = compareMeasurementsToBaseline(mixed, {
      lookup: found(baselineOf([violation()])),
    });
    const section = baselineSection(comparison) ?? "";

    expect(comparison.unclassified).toEqual([unplaceable]);
    expect(section).toContain("every one Gate could place against the base");
    expect(section).toContain("Not classified");
  });

  it("claims nothing at all when every violation is unclassified", () => {
    const onlyUnplaceable = withMeasurements([violation({ route: "/brand-new" })]);
    const section =
      baselineSection(
        compareMeasurementsToBaseline(onlyUnplaceable, { lookup: found(baselineOf([])) }),
      ) ?? "";

    expect(section).not.toContain("No measured violation above is new");
    expect(section).toContain("0 introduced by this pull request");
  });
});

describe("the store and the lookup", () => {
  const key = { installationId: "1", owner: "acme", name: "web", commitSha: "base1" };

  it("reports an unseen commit as absent, not as clean", () => {
    const store = createInMemoryMeasurementBaselineStore();
    return lookupMeasurementBaseline(store, key).then((lookup) => {
      expect(lookup.status).toBe("absent");
    });
  });

  it("round-trips a recorded set and re-records the same commit in place", async () => {
    const store = createInMemoryMeasurementBaselineStore();
    await store.record({ ...key, snapshot: baselineOf([violation()], "base1") });
    await store.record({ ...key, snapshot: baselineOf([violation(), violation({ element: "#b" })], "base1") });

    const lookup = await lookupMeasurementBaseline(store, key);
    expect(lookup.status).toBe("found");
    expect(store.snapshots.size).toBe(1);
    expect(lookup.status === "found" ? lookup.snapshot.entries : []).toHaveLength(2);
  });

  it("does not read another repository's baseline", async () => {
    const store = createInMemoryMeasurementBaselineStore();
    await store.record({ ...key, snapshot: baselineOf([violation()], "base1") });

    expect((await lookupMeasurementBaseline(store, { ...key, name: "other" })).status).toBe("absent");
    expect((await lookupMeasurementBaseline(store, { ...key, owner: "other" })).status).toBe("absent");
    expect((await lookupMeasurementBaseline(store, { ...key, commitSha: "other" })).status).toBe("absent");
  });

  it("degrades a store failure into 'cannot classify', never into a missing review", async () => {
    const lookup = await lookupMeasurementBaseline(
      {
        async record() {},
        async find() {
          throw new Error("connection refused");
        },
      },
      key,
    );

    expect(lookup.status).toBe("unavailable");
    expect(lookup.status === "unavailable" ? lookup.detail : "").toContain("could not be read");
  });

  it("says which of 'no store' and 'nothing stored' happened", async () => {
    const none = await lookupMeasurementBaseline(undefined, key);
    expect(none.status).toBe("unavailable");
    expect(none.status === "unavailable" ? none.detail : "").toContain("no baseline store is configured");
  });
});

describe("the measured result the golden fixture carries", () => {
  it("compares against itself with nothing introduced", () => {
    // The engine's own measured fixture, played back as its own base: a run that
    // changed nothing must introduce nothing.
    const measured = loadMeasuredReviewResult();
    const comparison = compareMeasurementsToBaseline(measured, {
      lookup: found(buildMeasurementBaseline(measured, { commitSha: "base" })),
    });

    expect(comparison.status).toBe("compared");
    expect(comparison.introduced).toEqual([]);
    expect(comparison.unclassified).toEqual([]);
    expect(comparison.preExisting).toHaveLength(measured.measurements?.violations.length ?? 0);
    expect(comparison.resolved).toBe(0);
  });
});
