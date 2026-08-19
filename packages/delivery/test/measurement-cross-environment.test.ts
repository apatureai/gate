import { loadGoldenReviewResult, type GateReviewResult, type Measurement } from "@gate/types";
import { describe, expect, it } from "vitest";
import {
  baselineSection,
  baselineSupersedes,
  buildMeasurementBaseline,
  captureOrigin,
  carryMeasurementBaselineForward,
  compareMeasurementsToBaseline,
  crossEnvironmentComparison,
  gateableMeasurements,
  isPreviewMeasured,
  measurementEnvironment,
  measurementsAreBlocking,
  type MeasurementBaselineSnapshot,
  type MeasurementEnvironment,
} from "../src/index.js";

/**
 * COMPARING LIKE WITH LIKE: the two sides of a comparison have to have been
 * rendered by the same kind of deployment before a difference between them can
 * be blamed on a pull request.
 *
 * Until a push could record a baseline, they always were: both sides came from a
 * pull request's preview. Measuring the default branch broke that, because
 * `preview.default_branch_url` is production for most teams, and production
 * differs from a preview in ways no pull request caused. A violation those
 * differences produce is present on one side and absent on the other, matches
 * nothing, and is called INTRODUCED, which under `block` fails a build that
 * broke nothing.
 *
 * WHAT THESE TESTS ARE MOSTLY GUARDING IS THE OTHER DIRECTION. The obvious fix
 * is a rule of the form "the two addresses must match", and it is a kill switch:
 * preview URLs differ per pull request by construction, so that rule refuses
 * every comparison Gate has ever made and switches gating off for everybody. So
 * the first test here is the ORDINARY case, two previews at two different
 * addresses, and it must still fail a build.
 */

const PREVIEW_BASE = measurementEnvironment("pull_request_preview", "https://web-git-pr41.example.app");
const PREVIEW_HEAD = measurementEnvironment("pull_request_preview", "https://web-git-pr42.example.app");
const PRODUCTION = measurementEnvironment("default_branch", "https://app.example.com");

const violation = (over: Partial<Measurement> = {}): Measurement => ({
  kind: "contrast",
  route: "/pricing",
  viewports: ["mobile"],
  element: "#hero-subtitle",
  detail: "text contrast 3.23:1 is below WCAG AA 4.5:1",
  blockEligible: true,
  ...over,
});

const withMeasurements = (violations: Measurement[]): GateReviewResult => ({
  ...loadGoldenReviewResult(),
  measurements: { checksRun: ["contrast", "overflow", "touch_target"], violations },
  coverage: {
    routesRequested: ["/pricing", "/checkout"],
    routesReviewed: ["/pricing", "/checkout"],
    viewportsRequested: ["mobile"],
    viewportsReviewed: ["mobile"],
  },
});

const baselineOf = (
  violations: Measurement[],
  measuredAt: MeasurementEnvironment | undefined,
): MeasurementBaselineSnapshot =>
  buildMeasurementBaseline(withMeasurements(violations), {
    commitSha: "basesha0000",
    ...(measuredAt ? { measuredAt } : {}),
  });

/** Compare `now` against a stored set, stating where each side was rendered. */
const compare = (
  now: Measurement[],
  base: MeasurementBaselineSnapshot,
  options: { measuredAt?: MeasurementEnvironment; declared?: boolean } = {},
) =>
  compareMeasurementsToBaseline(withMeasurements(now), {
    lookup: { status: "found", snapshot: base },
    ...(options.measuredAt ? { measuredAt: options.measuredAt } : {}),
    ...(options.declared !== undefined ? { environmentsDeclaredEquivalent: options.declared } : {}),
  });

const NEW_ONE = violation({ element: "#pricing-note", detail: "text contrast 2.10:1 is below WCAG AA 4.5:1" });

describe("the ordinary case still fires: two previews are comparable however different their addresses", () => {
  it("calls a violation introduced when both sides were rendered by a pull request preview", () => {
    // Two DIFFERENT origins, which is what previews always are: one per pull
    // request. A rule that compared addresses would decline here, and declining
    // here is the whole feature switched off.
    expect(PREVIEW_BASE.origin).not.toBe(PREVIEW_HEAD.origin);

    const comparison = compare([violation(), NEW_ONE], baselineOf([violation()], PREVIEW_BASE), {
      measuredAt: PREVIEW_HEAD,
    });

    expect(comparison.crossEnvironment).toBeUndefined();
    expect(comparison.introduced).toHaveLength(1);
    expect(comparison.introduced[0]?.element).toBe("#pricing-note");
    expect(comparison.preExisting).toHaveLength(1);
    // And it reaches the gate, which is the claim that matters.
    expect(gateableMeasurements(comparison)).toHaveLength(1);
  });

  it("still counts a resolved violation and still calls a worsened band worse", () => {
    const base = baselineOf([violation({ severity: 1 }), violation({ element: "#gone" })], PREVIEW_BASE);
    const comparison = compare([violation({ severity: 3 })], base, { measuredAt: PREVIEW_HEAD });

    expect(comparison.worsened).toHaveLength(1);
    expect(comparison.resolved).toBe(1);
  });
});

describe("a baseline rendered by the default branch's deployment is compared but not attributed", () => {
  const base = baselineOf([violation()], PRODUCTION);

  it("reports what would have been introduced as unclassified, and names the reason", () => {
    const comparison = compare([violation(), NEW_ONE], base, { measuredAt: PREVIEW_HEAD });

    expect(comparison.crossEnvironment).toEqual({ baseline: PRODUCTION, current: PREVIEW_HEAD });
    expect(comparison.introduced).toHaveLength(0);
    expect(comparison.unclassified).toHaveLength(1);
    expect(comparison.classified.find((row) => row.origin === "unclassified")?.reason).toBe(
      "cross_environment",
    );
  });

  it("gates on nothing, which is the point", () => {
    const comparison = compare([violation(), NEW_ONE], base, { measuredAt: PREVIEW_HEAD });
    expect(gateableMeasurements(comparison)).toHaveLength(0);
    expect(measurementsAreBlocking(withMeasurements([violation(), NEW_ONE]), "block", [], comparison)).toBe(
      false,
    );
  });

  it("still says a violation that MATCHED the base was already there", () => {
    // The half of the answer that survives crossing environments: a violation
    // present in both renderings is evidence it predates this pull request,
    // whatever rendered them. Withholding that too would report a mature
    // repository's whole back catalogue as unplaceable.
    const comparison = compare([violation(), NEW_ONE], base, { measuredAt: PREVIEW_HEAD });
    expect(comparison.preExisting).toHaveLength(1);
    expect(comparison.preExisting[0]?.element).toBe("#hero-subtitle");
  });

  it("does not call a band that rose WORSE, and keeps both bands on the row", () => {
    // A band is the worst measurement across a rendering. Different seed data or
    // a different signed-in state moves it on markup nobody touched, and a
    // worsened violation fails a `block` check exactly like an introduced one.
    const banded = baselineOf([violation({ severity: 1 })], PRODUCTION);
    const comparison = compare([violation({ severity: 3 })], banded, { measuredAt: PREVIEW_HEAD });

    expect(comparison.worsened).toHaveLength(0);
    expect(comparison.preExisting).toHaveLength(1);
    const row = comparison.classified[0];
    expect(row?.worsened).toBeUndefined();
    // The numbers are still reported: what is withheld is the attribution, not
    // the fact.
    expect(row?.baselineSeverity).toBe(1);
    expect(row?.currentSeverity).toBe(3);
  });

  it("counts nothing as resolved, because a violation only production renders is not a fix", () => {
    const twoOnTheBase = baselineOf([violation(), violation({ element: "#cookie-banner p" })], PRODUCTION);
    const comparison = compare([violation()], twoOnTheBase, { measuredAt: PREVIEW_HEAD });

    expect(comparison.resolved).toBe(0);
    // The control: the same shapes, both sides preview-rendered, does count it.
    const previewBase = baselineOf([violation(), violation({ element: "#cookie-banner p" })], PREVIEW_BASE);
    expect(compare([violation()], previewBase, { measuredAt: PREVIEW_HEAD }).resolved).toBe(1);
  });

  it("prefers the narrower reason when a violation is ALSO at a viewport the base never measured", () => {
    // Both reasons are true; `viewport_not_measured` is the one a reader can act
    // on, so it keeps precedence and its existing behaviour is untouched.
    const onlyMobile = baselineOf([violation()], PRODUCTION);
    const comparison = compare([violation({ viewports: ["desktop"], element: "#new" })], onlyMobile, {
      measuredAt: PREVIEW_HEAD,
    });

    expect(comparison.classified.find((row) => row.origin === "unclassified")?.reason).toBe(
      "viewport_not_measured",
    );
  });
});

describe("what is NOT a cross-environment comparison", () => {
  it("treats an unknown environment on the stored side as unknown, not as a difference", () => {
    // Every baseline already in the field on the day this shipped has no
    // environment. Reading that as a difference would have switched attribution
    // off for every repository at once.
    const comparison = compare([violation(), NEW_ONE], baselineOf([violation()], undefined), {
      measuredAt: PREVIEW_HEAD,
    });

    expect(comparison.crossEnvironment).toBeUndefined();
    expect(comparison.introduced).toHaveLength(1);
  });

  it("treats an unknown environment on THIS side the same way", () => {
    const comparison = compare([violation(), NEW_ONE], baselineOf([violation()], PRODUCTION));

    expect(comparison.crossEnvironment).toBeUndefined();
    expect(comparison.introduced).toHaveLength(1);
  });

  it("compares normally when the two surfaces differ but the address is the same", () => {
    // A repository whose default branch deploys to the same address its reviews
    // are pointed at. Two captures at one address are one deployment, whatever
    // recorded them.
    const sameAddress = measurementEnvironment("default_branch", "https://web-git-pr42.example.app");
    const comparison = compare([violation(), NEW_ONE], baselineOf([violation()], sameAddress), {
      measuredAt: PREVIEW_HEAD,
    });

    expect(comparison.crossEnvironment).toBeUndefined();
    expect(comparison.introduced).toHaveLength(1);
  });

  it("compares normally when the repository declared the two equivalent", () => {
    const comparison = compare([violation(), NEW_ONE], baselineOf([violation()], PRODUCTION), {
      measuredAt: PREVIEW_HEAD,
      declared: true,
    });

    expect(comparison.crossEnvironment).toBeUndefined();
    expect(comparison.introduced).toHaveLength(1);
    expect(gateableMeasurements(comparison)).toHaveLength(1);
  });
});

describe("crossEnvironmentComparison: the predicate on its own", () => {
  it("fires only when both sides are known, the surfaces differ, and nothing says otherwise", () => {
    expect(crossEnvironmentComparison(PRODUCTION, PREVIEW_HEAD)).toEqual({
      baseline: PRODUCTION,
      current: PREVIEW_HEAD,
    });
    expect(crossEnvironmentComparison(PREVIEW_BASE, PREVIEW_HEAD)).toBeUndefined();
    expect(crossEnvironmentComparison(undefined, PREVIEW_HEAD)).toBeUndefined();
    expect(crossEnvironmentComparison(PRODUCTION, undefined)).toBeUndefined();
    expect(crossEnvironmentComparison(PRODUCTION, PREVIEW_HEAD, true)).toBeUndefined();
  });

  it("does not read two MISSING addresses as the same address", () => {
    // The `null === null` mistake, in a place it would silently restore the bug:
    // two environments that could not state an origin are not thereby one
    // deployment.
    const surfaceOnly = { surface: "default_branch" as const };
    const otherSurfaceOnly = { surface: "pull_request_preview" as const };
    expect(crossEnvironmentComparison(surfaceOnly, otherSurfaceOnly)).toEqual({
      baseline: surfaceOnly,
      current: otherSurfaceOnly,
    });
  });

  it("is symmetric about which side is the default branch", () => {
    expect(crossEnvironmentComparison(PREVIEW_BASE, PRODUCTION)).toEqual({
      baseline: PREVIEW_BASE,
      current: PRODUCTION,
    });
  });
});

describe("captureOrigin and measurementEnvironment", () => {
  it("keeps scheme, host and port, and drops the path", () => {
    expect(captureOrigin("https://app.example.com:8443/pricing?x=1")).toBe("https://app.example.com:8443");
  });

  it("answers undefined for anything that is not an address two sides could share", () => {
    expect(captureOrigin("not a url")).toBeUndefined();
    expect(captureOrigin("")).toBeUndefined();
    expect(captureOrigin(null)).toBeUndefined();
    expect(captureOrigin(undefined)).toBeUndefined();
    // `new URL("file:///x").origin` is the STRING "null", which would compare
    // equal to another one and declare two unrelated captures the same
    // deployment.
    expect(captureOrigin("file:///tmp/index.html")).toBeUndefined();
  });

  it("leaves the origin key off entirely when there is no origin to state", () => {
    // Absent, not present-and-undefined: the SQL binding writes NULL from an
    // absent key, and a key carrying `undefined` is how an empty string reaches
    // a column that is only ever read as "these two are the same deployment".
    expect("origin" in measurementEnvironment("default_branch", "not a url")).toBe(false);
    expect(measurementEnvironment("default_branch", "not a url")).toEqual({ surface: "default_branch" });
    expect(measurementEnvironment("pull_request_preview", "https://x.example.com")).toEqual({
      surface: "pull_request_preview",
      origin: "https://x.example.com",
    });
  });
});

describe("baselineSupersedes: which set wins when a merge fires both mechanisms", () => {
  const preview = baselineOf([violation()], PREVIEW_BASE);
  const pushed = baselineOf([violation()], PRODUCTION);
  const unknown = baselineOf([violation()], undefined);

  it("prefers the preview-measured set over the one measured at the default branch", () => {
    expect(baselineSupersedes(preview, pushed)).toBe(true);
    expect(baselineSupersedes(pushed, preview)).toBe(false);
  });

  it("prefers a preview-measured set over one that cannot say where it was rendered", () => {
    expect(baselineSupersedes(preview, unknown)).toBe(true);
    expect(baselineSupersedes(unknown, preview)).toBe(false);
  });

  it("never replaces like with like, so nothing flip-flops", () => {
    expect(baselineSupersedes(preview, preview)).toBe(false);
    expect(baselineSupersedes(pushed, pushed)).toBe(false);
    expect(baselineSupersedes(unknown, unknown)).toBe(false);
  });

  it("reads a carried set as preview-measured, because that is where it was rendered", () => {
    const carried = carryMeasurementBaselineForward(preview, { commitSha: "mergesha000" });
    expect(carried.measuredAt).toEqual(PREVIEW_BASE);
    expect(isPreviewMeasured(carried)).toBe(true);
    expect(baselineSupersedes(carried, pushed)).toBe(true);
  });
});

describe("the surfaces say what happened", () => {
  const base = baselineOf([violation()], PRODUCTION);

  it("names both deployments, what it withheld, and the way out", () => {
    const comparison = compare([violation(), NEW_ONE], base, { measuredAt: PREVIEW_HEAD });
    const section = baselineSection(comparison, { mode: "block", blocking: false });

    expect(section).toContain("https://app.example.com");
    expect(section).toContain("https://web-git-pr42.example.app");
    expect(section).toContain("not classified");
    expect(section).toContain("default_branch_renders_like_preview");
  });

  it("does not let the closing block sentence read as a clean pull request", () => {
    // The sentence lists the conditions a violation must meet to fail the check.
    // On a cross-environment run NOTHING can meet them, and a reader who is not
    // told that concludes the pull request is clean.
    const comparison = compare([violation(), NEW_ONE], base, { measuredAt: PREVIEW_HEAD });
    const section = baselineSection(comparison, { mode: "block", blocking: false });

    expect(section).toContain("rendered by different deployments");
    expect(section).toContain("`block` is switched off here");
  });

  it("says none of it on an ordinary run, so the two do not print the same page", () => {
    const comparison = compare([violation(), NEW_ONE], baselineOf([violation()], PREVIEW_BASE), {
      measuredAt: PREVIEW_HEAD,
    });
    const section = baselineSection(comparison, { mode: "block", blocking: true });

    expect(section).not.toContain("different deployments");
    expect(section).toContain("1 introduced by this pull request");
  });

  it("says the address was not recorded rather than printing an empty span", () => {
    const nameless = baselineOf([violation()], { surface: "default_branch" });
    const comparison = compare([violation(), NEW_ONE], nameless, { measuredAt: PREVIEW_HEAD });
    const section = baselineSection(comparison, { mode: "advisory" });

    expect(section).toContain("address not recorded");
  });
});
