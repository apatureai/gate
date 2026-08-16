import { loadGoldenReviewResult } from "@gate/types";
import type { GateReviewResult, ReviewCoverage } from "@gate/types";
import { describe, expect, it } from "vitest";
import {
  buildCheckRun,
  coverageState,
  renderStickyComment,
  suppressesGradeForCoverage,
} from "../src/index.js";

/**
 * Coverage on the Check Run (verdict#165).
 *
 * The state under test: a result with zero findings grades `ship` by
 * construction, so an empty capture, a run whose every critique failed
 * validation, and a genuinely clean page are byte-identical apart from
 * `coverage`. Before this, all three published a green ✅ while the sticky
 * comment beside them listed what had been skipped.
 *
 * The three cases below are one guard and its two regression rails. The middle
 * one is the important rail: the naive fix ("zero findings plus a non-empty
 * notReviewed is not a pass") turns a clean PARTIAL review red, which punishes
 * the engine for being honest about what it skipped.
 */

const golden = loadGoldenReviewResult();

const FULL_COVERAGE: ReviewCoverage = {
  routesRequested: ["/pricing"],
  routesReviewed: ["/pricing"],
  viewportsRequested: ["mobile", "desktop"],
  viewportsReviewed: ["mobile", "desktop"],
};

/** A clean result: whatever coverage says, the payload looks like a passing page. */
function clean(over: Partial<GateReviewResult> = {}): GateReviewResult {
  return {
    ...golden,
    grade: "ship",
    overall: "No issues found.",
    findings: [],
    artifacts: { annotatedScreenshots: [] },
    notReviewed: [],
    coverage: FULL_COVERAGE,
    ...over,
  };
}

describe("coverageState", () => {
  it("reads an empty reviewed-route set as `nothing`, whatever the grade says", () => {
    const result = clean({
      coverage: { ...FULL_COVERAGE, routesReviewed: [], viewportsReviewed: [] },
    });
    expect(result.grade).toBe("ship");
    expect(coverageState(result)).toBe("nothing");
    expect(suppressesGradeForCoverage(coverageState(result))).toBe(true);
  });

  it("reads a missing coverage field as `unstated`, never as full", () => {
    const { coverage: _dropped, ...withoutCoverage } = clean();
    expect(coverageState(withoutCoverage as GateReviewResult)).toBe("unstated");
    expect(suppressesGradeForCoverage("unstated")).toBe(false);
  });

  it("distinguishes full from partial on routes and on viewports independently", () => {
    expect(coverageState(clean())).toBe("full");
    expect(
      coverageState(
        clean({ coverage: { ...FULL_COVERAGE, routesRequested: ["/pricing", "/checkout"] } }),
      ),
    ).toBe("partial");
    expect(
      coverageState(clean({ coverage: { ...FULL_COVERAGE, viewportsReviewed: ["mobile"] } })),
    ).toBe("partial");
  });

  it("does not call a run partial for reviewing something nobody asked for", () => {
    expect(
      coverageState(
        clean({ coverage: { ...FULL_COVERAGE, routesReviewed: ["/pricing", "/bonus"] } }),
      ),
    ).toBe("full");
  });
});

describe("buildCheckRun: the three coverage cases", () => {
  it("CASE 1 nothing reviewed: neutral, no grade, and it says so", () => {
    const result = clean({
      coverage: {
        routesRequested: ["/pricing", "/checkout"],
        routesReviewed: [],
        viewportsRequested: ["mobile", "desktop"],
        viewportsReviewed: [],
      },
      notReviewed: [
        "route /pricing (no captured image)",
        "route /checkout (no preview deployment matched the head SHA)",
      ],
    });

    const run = buildCheckRun(result, "none");

    expect(run.conclusion).toBe("neutral");
    expect(run.title).toBe("Nothing reviewed");
    // No grade anywhere in the summary, and the reason is stated in words.
    expect(run.summary).not.toContain("**Grade:**");
    expect(run.summary).toContain("**No grade.**");
    expect(run.summary).toContain("reviewed nothing");
    expect(run.summary).toContain("0 of 2 requested routes");
    // ... and what was skipped is named on this surface, not only in the comment.
    expect(run.summary).toContain("Not reviewed");
    expect(run.summary).toContain("no captured image");
    expect(run.summary).toContain("no preview deployment matched the head SHA");
  });

  it("CASE 2 partial coverage, zero findings: success, and the summary names what was skipped", () => {
    // THE REGRESSION RAIL. This is a real, clean review of the routes that were
    // reachable. The rule "zero findings + non-empty notReviewed => not success"
    // would fail it, which is why coverage is on the contract instead.
    const result = clean({
      coverage: {
        routesRequested: ["/pricing", "/checkout"],
        routesReviewed: ["/pricing"],
        viewportsRequested: ["mobile", "tablet", "desktop"],
        viewportsReviewed: ["mobile", "desktop"],
      },
      notReviewed: [
        "route /checkout (no preview deployment matched the head SHA)",
        "viewport tablet (not configured)",
      ],
    });

    const run = buildCheckRun(result, "blockers");

    expect(coverageState(result)).toBe("partial");
    expect(run.conclusion).toBe("success");
    expect(run.title).toBe("Ship");
    expect(run.summary).toContain("**Grade:** Ship");
    // The pass is qualified: the summary names the route and the viewport it
    // never looked at, so "green" is never read as "all of it".
    expect(run.summary).toContain("1 of 2 route(s) reviewed");
    expect(run.summary).toContain("/checkout");
    expect(run.summary).toContain("tablet");
    expect(run.summary).toContain("Not reviewed");
  });

  it("CASE 3 full coverage, zero findings: success", () => {
    const run = buildCheckRun(clean(), "blockers");

    expect(coverageState(clean())).toBe("full");
    expect(run.conclusion).toBe("success");
    expect(run.title).toBe("Ship");
    expect(run.summary).toContain("**Grade:** Ship");
    expect(run.summary).toContain("1 of 1 route(s) reviewed");
    // Nothing was skipped, so there is no skipped list to render.
    expect(run.summary).not.toContain("Not reviewed");
  });
});

describe("buildCheckRun: coverage in the rest of the summary", () => {
  it("renders notReviewed on the Check Run for a graded run, so the two surfaces agree", () => {
    const result = { ...golden, notReviewed: ["route /checkout (no preview deployment matched)"] };
    const run = buildCheckRun(result, "none");
    const comment = renderStickyComment(result, { headSha: "0123456789abcdef" });
    for (const surface of [run.summary, comment]) {
      expect(surface).toContain("Not reviewed");
      expect(surface).toContain("/checkout");
    }
  });

  it("says out loud when the engine reported no coverage at all", () => {
    const { coverage: _dropped, ...withoutCoverage } = clean();
    const run = buildCheckRun(withoutCoverage as GateReviewResult, "none");
    // Deliberately still a pass: the engine positively attested that a model
    // judged the requested target, and the golden fixture proves the
    // notReviewed-based inference is wrong. But it is never SILENT about it.
    expect(run.conclusion).toBe("success");
    expect(run.summary).toContain("did not report which routes and viewports it reviewed");
  });

  it("keeps the grade for a partial run even when every skipped item is prose-only", () => {
    const result = clean({
      coverage: { ...FULL_COVERAGE, routesRequested: ["/pricing", "/checkout"] },
      notReviewed: [],
    });
    expect(buildCheckRun(result, "blockers").conclusion).toBe("success");
  });

  it("sanitizes engine-supplied notReviewed prose before publishing it", () => {
    const result = clean({
      notReviewed: ["route /x [click](https://evil.test) @maintainer <img src=x>"],
    });
    const run = buildCheckRun(result, "none");
    // Link syntax, HTML and the @mention are all defanged, not merely dropped.
    expect(run.summary).not.toContain("](https://evil.test)");
    expect(run.summary).toContain("\\[click\\]");
    expect(run.summary).toContain("\\<img src=x\\>");
    expect(run.summary).not.toContain(" @maintainer");
  });

  it("prefers the nothing-reviewed title when the judgment stamp is missing too", () => {
    const { provenance: _dropped, ...unattested } = clean({
      coverage: { ...FULL_COVERAGE, routesReviewed: [], viewportsReviewed: [] },
    });
    const run = buildCheckRun(unattested as GateReviewResult, "none");
    expect(run.conclusion).toBe("neutral");
    expect(run.title).toBe("Nothing reviewed");
  });
});

describe("renderStickyComment: agrees with the Check Run", () => {
  it("withholds the grade in the comment when nothing was reviewed", () => {
    const result = clean({
      coverage: { ...FULL_COVERAGE, routesReviewed: [], viewportsReviewed: [] },
      notReviewed: ["route /pricing (no captured image)"],
    });
    const comment = renderStickyComment(result, { headSha: "0123456789abcdef" });
    expect(comment).toContain("no design review");
    expect(comment).toContain("Nothing reviewed");
    expect(comment).not.toContain("✅ Ship");
    expect(buildCheckRun(result, "none").conclusion).toBe("neutral");
  });

  it("keeps the grade in the comment for a clean partial, exactly as the Check Run does", () => {
    const result = clean({
      coverage: { ...FULL_COVERAGE, routesRequested: ["/pricing", "/checkout"] },
      notReviewed: ["route /checkout (no preview deployment matched the head SHA)"],
    });
    const comment = renderStickyComment(result, { headSha: "0123456789abcdef" });
    expect(comment).toContain("✅ Ship");
    expect(comment).toContain("Not reviewed");
    expect(buildCheckRun(result, "none").conclusion).toBe("success");
  });
});

describe("an engine can retract its own grade", () => {
  // The case that reached a pull request as a green Ship: every model finding was
  // deleted before it could be reported, on a route that WAS reviewed. Coverage is
  // full and truthful, `grade` floors to `ship` because the field is required, and
  // only the engine knows the value means nothing. Gate used to strip the field at
  // parse and publish the green tick.
  const retracted = (over: Partial<GateReviewResult> = {}): GateReviewResult => ({
    ...loadGoldenReviewResult(),
    grade: "ship",
    findings: [],
    overall: "No finding in this review survived validation.",
    gradeUnavailableReason: "nothing_survived_validation",
    ...over,
  });

  it("does not publish a green check for a grade the engine retracted", () => {
    const run = buildCheckRun(retracted(), "none");
    expect(run.conclusion).toBe("neutral");
    expect(run.title).not.toBe("Ship");
    expect(run.summary).toContain("not a verdict about this page");
  });

  it("suppresses in blocking mode too, not only advisory", () => {
    for (const mode of ["none", "nits", "blockers"] as const) {
      expect(buildCheckRun(retracted(), mode).conclusion).toBe("neutral");
    }
  });

  it("treats a reason it has never heard of as a retraction", () => {
    // Gate deliberately does not enumerate the reasons. An engine that retracts
    // for a cause Gate has not been taught must not get a green tick by default.
    const run = buildCheckRun(retracted({ gradeUnavailableReason: "some_future_reason" }), "none");
    expect(run.conclusion).toBe("neutral");
  });

  it("still publishes a grade when the engine did not retract it", () => {
    const clean = { ...loadGoldenReviewResult(), grade: "ship" as const, findings: [], overall: "Clean." };
    expect(buildCheckRun(clean, "none").conclusion).toBe("success");
    expect(buildCheckRun({ ...clean, gradeUnavailableReason: "" }, "none").conclusion).toBe("success");
  });
});
