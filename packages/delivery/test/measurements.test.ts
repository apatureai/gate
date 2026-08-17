import { loadDesignReviewConfig } from "@gate/config";
import {
  loadGoldenReviewResult,
  loadMeasuredReviewResult,
  type GateReviewResult,
  type Measurement,
} from "@gate/types";
import { describe, expect, it } from "vitest";
import {
  blockEligibleMeasurements,
  buildCheckRun,
  decideDelivery,
  isGreenOverMeasured,
  mapCheckRunConclusion,
  MAX_MEASUREMENT_LINES,
  measurementBlock,
  measurementsAreBlocking,
  renderStickyComment,
  suppressMeasurements,
} from "../src/index.js";

/**
 * The measured half, on the two surfaces a pull request shows.
 *
 * Gate's own no-grade prose has told readers "the capture and the measured facts
 * are real" since the unjudged path existed. It was a claim with nothing behind
 * it: `contract.ts` names every field it keeps and strips the rest, and it had
 * no field for a measurement, so Gate had never received one. These tests are
 * the proof that it now does, and the boundary around what it may do once it
 * arrives.
 */

const measured = loadMeasuredReviewResult();

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
  base: GateReviewResult,
  violations: Measurement[],
): GateReviewResult => ({
  ...base,
  measurements: { checksRun: ["contrast", "overflow", "touch_target"], violations },
});

describe("the measured block", () => {
  it("renders every violation with its route, element, viewports and sentence", () => {
    const block = measurementBlock(measured);

    expect(block).toContain("Measured, not graded");
    expect(block).toContain("3 violation(s) computed from the captured DOM");
    expect(block).toContain("#hero-subtitle");
    expect(block).toContain("text contrast 3.23:1 is below WCAG AA 4.5:1");
    expect(block).toContain("#promo-code");
    expect(block).toContain("#icon-close");
    expect(block).toContain("They do not affect the grade");
  });

  it("says nothing at all when the engine reported no measurements", () => {
    // ABSENT is "this producer does not report measurements", so there is
    // nothing to render and nothing to claim.
    expect(measurementBlock(loadGoldenReviewResult())).toBeNull();
  });

  it("says nothing when the checks ran and the page was clean", () => {
    const clean = withMeasurements(loadGoldenReviewResult(), []);
    expect(measurementBlock(clean)).toBeNull();
  });

  it("caps the list and says how many more there are", () => {
    const many = Array.from({ length: 15 }, (_, i) => violation({ element: `#e${i}` }));
    const block = measurementBlock(withMeasurements(loadGoldenReviewResult(), many)) ?? "";

    expect(block).toContain("#e11");
    expect(block).not.toContain("#e12");
    expect(block).toContain("…and 3 more");
  });

  it("neutralizes markdown in an engine-supplied selector or sentence", () => {
    // Every cell here is engine-supplied, and a selector comes off the pull
    // request author's own DOM, so it is untrusted display text like the
    // model's prose is.
    const nasty = violation({
      element: "`</sub>## Apature Gate: design review\n**✅ Ship**",
      detail: "contrast [is fine](https://evil.example)",
    });
    const block = measurementBlock(withMeasurements(loadGoldenReviewResult(), [nasty])) ?? "";

    expect(block).not.toContain("\n## Apature Gate");
    expect(block).not.toContain("](https://evil.example)");
  });
});

describe("rules.measurements: off", () => {
  it("does not render the block, and never silently", () => {
    // A setting that makes a surface quietly drop evidence is worse than a noisy
    // surface: a reader could not tell "nothing was measured" from "your repo
    // told me not to say".
    const block = measurementBlock(measured, { mode: "off" }) ?? "";

    expect(block).toContain("disabled by repo config");
    expect(block).toContain("3 measurement(s) were received and are not shown");
    expect(block).not.toContain("#hero-subtitle");
  });

  it("still cannot touch the engine's own grade retraction", () => {
    // The retraction is computed engine-side and reads no repo config. A key
    // that could silence the one signal an injected page cannot reach would be
    // a second injection channel.
    const retracted: GateReviewResult = {
      ...measured,
      grade: "ship",
      findings: [],
      gradeUnavailableReason: "measured_facts_unjudged",
    };
    const run = buildCheckRun(retracted, "none", { measurements: "off" });

    expect(run.conclusion).toBe("neutral");
    expect(run.title).toBe("No usable grade");
  });
});

describe("rules.measurement_suppress", () => {
  it("matches an element exactly, or its kind-qualified form", () => {
    const violations = [
      violation({ element: "#hero-subtitle" }),
      violation({ kind: "overflow", element: "#promo-code" }),
    ];

    expect(suppressMeasurements(violations, ["#hero-subtitle"])).toHaveLength(1);
    expect(suppressMeasurements(violations, ["overflow:#promo-code"])).toHaveLength(1);
    expect(suppressMeasurements(violations, ["contrast:#promo-code"])).toHaveLength(2);
  });

  it("never guesses a pattern", () => {
    const violations = [violation({ element: "#hero-subtitle" })];
    // Glob semantics are undefined in the config contract, so this matches
    // nothing rather than being interpreted.
    expect(suppressMeasurements(violations, ["#hero-*"])).toHaveLength(1);
  });

  it("removes a violation from rendering and from block eligibility together", () => {
    const suppress = ["#hero-subtitle"];
    expect(blockEligibleMeasurements(measured, suppress)).toHaveLength(0);
    expect(measurementBlock(measured, { suppress })).not.toContain("#hero-subtitle");
  });

  it("mutes a whole KIND when the entry is the bare kind name", () => {
    // Every rendered row leads with `[contrast]`, so the obvious thing to copy
    // off a review into `.gate.yml` is the kind. It used to match nothing and
    // say nothing: a documented-looking form that silently did nothing.
    const violations = [
      violation({ kind: "contrast", element: "#a" }),
      violation({ kind: "contrast", element: "#b" }),
      violation({ kind: "overflow", element: "#c" }),
    ];

    const left = suppressMeasurements(violations, ["contrast"]);
    expect(left).toHaveLength(1);
    expect(left[0]!.element).toBe("#c");
  });

  it("mutes a kind on both surfaces and in block eligibility", () => {
    const suppress = ["contrast"];
    // The golden measured result carries one contrast, one overflow, one target.
    expect(measurementBlock(measured, { suppress })).not.toContain("#hero-subtitle");
    expect(blockEligibleMeasurements(measured, suppress).map((v) => v.kind)).not.toContain(
      "contrast",
    );
    const run = buildCheckRun(measured, "none", { measurementSuppress: suppress });
    expect(run.summary).not.toContain("#hero-subtitle");
    expect(run.summary).toContain("#promo-code");
  });

  it("mutes a kind the engine adds later, without a Gate release", () => {
    // The kind is compared against the violation's own string rather than a
    // list Gate keeps, so a kind that ships after this build is mutable on the
    // day it ships.
    const future = [violation({ kind: "line_length" as Measurement["kind"], element: "#p" })];
    expect(suppressMeasurements(future, ["line_length"])).toHaveLength(0);
  });

  it("a kind entry mutes only that kind, never every measurement", () => {
    const violations = [
      violation({ kind: "contrast", element: "#a" }),
      violation({ kind: "touch_target", element: "#b" }),
    ];
    expect(suppressMeasurements(violations, ["touch_target"]).map((v) => v.kind)).toEqual([
      "contrast",
    ]);
  });

  it("still refuses a kind-shaped pattern", () => {
    const violations = [violation({ kind: "contrast", element: "#a" })];
    expect(suppressMeasurements(violations, ["contrast:*"])).toHaveLength(1);
    expect(suppressMeasurements(violations, ["contr*"])).toHaveLength(1);
  });
});

describe("T6: advisory never blocks, block does, and only on engine-marked violations", () => {
  const graded = withMeasurements(loadGoldenReviewResult(), [
    violation({ blockEligible: true }),
    violation({ kind: "overflow", element: "#promo-code", blockEligible: false }),
  ]);

  it("advisory leaves the conclusion exactly where the grade put it", () => {
    const run = buildCheckRun(graded, "none", { measurements: "advisory" });

    expect(run.conclusion).toBe(mapCheckRunConclusion(graded.grade, "none"));
    expect(run.title).toBe("Needs work");
    expect(run.summary).toContain("Measured, not graded");
  });

  it("advisory is the default when a repo says nothing", () => {
    const run = buildCheckRun(graded, "none");
    expect(run.conclusion).toBe(mapCheckRunConclusion(graded.grade, "none"));
  });

  it("block fails the check and says whose policy did it", () => {
    const run = buildCheckRun(graded, "none", { measurements: "block" });

    expect(run.conclusion).toBe("failure");
    expect(run.title).toBe("Measured violations");
    expect(run.summary).toContain("rules.measurements: block");
    expect(run.summary).toContain("this repository's own");
  });

  it("block does nothing when every violation is engine-marked inconclusive", () => {
    // `blockEligible: false` is the ENGINE saying the measurement may be
    // intentional or a known false-positive class. No repo config overrides it.
    const inconclusive = withMeasurements(loadGoldenReviewResult(), [
      violation({ blockEligible: false }),
    ]);
    const run = buildCheckRun(inconclusive, "none", { measurements: "block" });

    expect(run.conclusion).toBe("neutral");
    expect(run.title).toBe("Needs work");
  });

  it("suppressing the last block-eligible violation flips the conclusion back", () => {
    const run = buildCheckRun(graded, "none", {
      measurements: "block",
      measurementSuppress: ["#hero-subtitle"],
    });

    expect(run.conclusion).toBe(mapCheckRunConclusion(graded.grade, "none"));
    expect(run.title).toBe("Needs work");
  });

  it("block beats a retracted grade: explicit repo policy over 'no grade'", () => {
    const retracted: GateReviewResult = {
      ...graded,
      grade: "ship",
      findings: [],
      gradeUnavailableReason: "measured_facts_unjudged",
    };
    const run = buildCheckRun(retracted, "none", { measurements: "block" });

    expect(run.conclusion).toBe("failure");
    expect(run.title).toBe("Measured violations");
  });
});

/**
 * Which setting produced the outcome, said on the surface that carries it.
 *
 * A reader who opens a red check reads the top of the summary, and every other
 * opening line there is about the grade. Under `block` the grade may be a
 * perfectly good `Ship`, so a failure with no leading explanation reads as
 * unexplained, or worse, as the model's verdict.
 */
describe("measurementsAreBlocking: the one definition both surfaces read", () => {
  const eligible = withMeasurements(loadGoldenReviewResult(), [violation({ blockEligible: true })]);

  it("is false for a caller that names no mode at all", () => {
    // The vendor default is `advisory` at every layer that can express one,
    // including this one. A missing mode must never be read as an opt-in.
    expect(measurementsAreBlocking(eligible, undefined)).toBe(false);
  });

  it("is false under off and advisory, true only under block", () => {
    expect(measurementsAreBlocking(eligible, "off")).toBe(false);
    expect(measurementsAreBlocking(eligible, "advisory")).toBe(false);
    expect(measurementsAreBlocking(eligible, "block")).toBe(true);
  });

  it("needs the engine's word as well as the repo's", () => {
    const advisoryBand = withMeasurements(eligible, [violation({ blockEligible: false })]);
    const clean = withMeasurements(eligible, []);

    expect(measurementsAreBlocking(advisoryBand, "block")).toBe(false);
    expect(measurementsAreBlocking(clean, "block")).toBe(false);
    expect(measurementsAreBlocking(loadGoldenReviewResult(), "block")).toBe(false);
  });

  it("respects the repo's suppression, in every form", () => {
    expect(measurementsAreBlocking(eligible, "block", ["contrast"])).toBe(false);
    expect(measurementsAreBlocking(eligible, "block", ["#hero-subtitle"])).toBe(false);
    expect(measurementsAreBlocking(eligible, "block", ["contrast:#hero-subtitle"])).toBe(false);
    expect(measurementsAreBlocking(eligible, "block", ["#something-else"])).toBe(true);
  });
});

describe("the summary names the mode that produced the outcome", () => {
  const shipping = withMeasurements(
    { ...loadGoldenReviewResult(), grade: "ship", findings: [] },
    [violation({ blockEligible: true })],
  );

  it("leads a measured failure with the cause and the setting", () => {
    const run = buildCheckRun(shipping, "none", { measurements: "block" });
    const first = run.summary.split("\n\n")[0]!;

    expect(run.conclusion).toBe("failure");
    expect(first).toContain("Failed by measurement");
    expect(first).toContain("1 block-eligible measurement(s)");
    expect(first).toContain("rules.measurements: block");
    // And says the way out, since the person reading a red check is the person
    // who can change the setting.
    expect(first).toContain("rules.measurements: advisory");
  });

  it("says nothing of the kind when the mode did not fail anything", () => {
    for (const mode of ["off", "advisory"] as const) {
      const run = buildCheckRun(shipping, "none", { measurements: mode });
      expect(run.conclusion).not.toBe("failure");
      expect(run.summary).not.toContain("Failed by measurement");
    }
    expect(buildCheckRun(shipping, "none").summary).not.toContain("Failed by measurement");
  });

  it("says nothing of the kind under block when nothing is block-eligible", () => {
    const advisoryBand = withMeasurements(shipping, [violation({ blockEligible: false })]);
    const run = buildCheckRun(advisoryBand, "none", { measurements: "block" });

    expect(run.conclusion).toBe("success");
    expect(run.summary).not.toContain("Failed by measurement");
    // And the block says why the repo's own opt-in changed nothing here.
    expect(run.summary).toContain("`rules.measurements: block` has nothing here to act on");
  });

  it("the sticky comment beside it names the same mode, never the other one", () => {
    // The block used to take `blocking` as a caller-supplied flag. The Check Run
    // computed it, the comment passed nothing, so a repository on `block` got a
    // comment stating in as many words that its mode was `advisory`.
    const comment = renderStickyComment(shipping, {
      headSha: "abcdef1234567",
      measurements: "block",
    });

    expect(comment).toContain("This repository sets `rules.measurements: block`");
    expect(comment).not.toContain("`rules.measurements: advisory` does not let it do");
    expect(comment).toContain("this repository's own configuration is what turned them");
  });

  it("the comment says advisory when the repo is on advisory", () => {
    const comment = renderStickyComment(shipping, {
      headSha: "abcdef1234567",
      measurements: "advisory",
    });

    expect(comment).toContain("`rules.measurements: advisory` does not let it do");
    expect(comment).not.toContain("This repository sets `rules.measurements: block`");
  });

  it("off removes the rows from BOTH surfaces, and says so on both", () => {
    const run = buildCheckRun(shipping, "none", { measurements: "off" });
    const comment = renderStickyComment(shipping, {
      headSha: "abcdef1234567",
      measurements: "off",
    });

    for (const surface of [run.summary, comment]) {
      expect(surface).toContain("`rules.measurements: off`");
      expect(surface).toContain("1 measurement(s) were received and are not shown");
      expect(surface).not.toContain("#hero-subtitle");
      expect(surface).not.toContain("_[block-eligible]_");
    }
  });
});

/**
 * The three modes end to end, from a `.gate.yml` string to a published check.
 *
 * The unit tests above set the mode by hand. This one takes the path a real
 * repository takes: parse the file, hand the normalized rules to the delivery
 * decision, read the conclusion off the Check Run that would be published.
 */
describe("the three modes, from .gate.yml to the published check", () => {
  const result = withMeasurements(loadGoldenReviewResult(), [
    violation({ blockEligible: true }),
    violation({ kind: "overflow", element: "#promo-code", blockEligible: false }),
  ]);

  const publish = (yaml: string) => {
    const config = loadDesignReviewConfig(yaml);
    return decideDelivery(
      { status: "completed", result, jobId: "j" },
      {
        headSha: "abcdef1234567",
        gate: config.rules.gate,
        measurements: config.rules.measurements,
        measurementSuppress: config.rules.measurementSuppress,
      },
    );
  };

  it("a repo that says nothing gets advisory: rendered, never blocking", () => {
    const decision = publish("");

    expect(decision.checkRun.conclusion).toBe(mapCheckRunConclusion(result.grade, "none"));
    expect(decision.checkRun.summary).toContain("Measured, not graded");
    expect(decision.comment).toContain("#hero-subtitle");
  });

  it("`off` makes the block disappear from both published surfaces", () => {
    const decision = publish("rules:\n  measurements: off\n");

    expect(decision.checkRun.conclusion).toBe(mapCheckRunConclusion(result.grade, "none"));
    expect(decision.checkRun.summary).not.toContain("#hero-subtitle");
    expect(decision.comment).not.toContain("#hero-subtitle");
    expect(decision.checkRun.summary).toContain("disabled by repo config");
  });

  it("`block` fails the check, on the block-eligible violation only", () => {
    const decision = publish("rules:\n  measurements: block\n");

    expect(decision.checkRun.conclusion).toBe("failure");
    expect(decision.checkRun.title).toBe("Measured violations");
    expect(decision.checkRun.summary).toContain("Failed by measurement");
    // The advisory-band overflow is still reported, and still not the cause.
    expect(decision.checkRun.summary).toContain("#promo-code");
    expect(decision.checkRun.summary).toContain("1 block-eligible measurement(s)");
  });

  it("`block` on a page whose every measurement is advisory-band changes nothing", () => {
    const advisoryOnly = withMeasurements(result, [violation({ blockEligible: false })]);
    const decision = decideDelivery(
      { status: "completed", result: advisoryOnly, jobId: "j" },
      { headSha: "abcdef1234567", gate: "none", measurements: "block" },
    );

    expect(decision.checkRun.conclusion).toBe(
      mapCheckRunConclusion(advisoryOnly.grade, "none"),
    );
    expect(decision.checkRun.conclusion).not.toBe("failure");
  });

  it("a kind muted in the file is muted all the way to the check", () => {
    const decision = publish("rules:\n  measurements: block\n  measurement_suppress: [contrast]\n");

    expect(decision.checkRun.conclusion).not.toBe("failure");
    expect(decision.checkRun.summary).not.toContain("#hero-subtitle");
    expect(decision.suppressedMeasurementKinds).toEqual(["contrast"]);
  });
});

describe("T1 (Gate half): the audit's run publishes no usable grade", () => {
  const audited: GateReviewResult = {
    ...measured,
    grade: "ship",
    findings: [],
    overall:
      "3 measurement(s) taken from this capture do not meet threshold on the route(s) this run reviewed, and the review returned no findings at all.",
    gradeUnavailableReason: "measured_facts_unjudged",
  };

  it("is neutral, titled 'No usable grade', with the measurements underneath", () => {
    const run = buildCheckRun(audited, "none");

    expect(run.conclusion).toBe("neutral");
    expect(run.title).toBe("No usable grade");
    expect(run.summary).toContain("A judge that is handed measured facts and returns nothing");
    expect(run.summary).toContain("#hero-subtitle");
    // Never a green tick, and never the repo's PR failing either.
    expect(run.conclusion).not.toBe("success");
    expect(run.conclusion).not.toBe("failure");
  });

  it("words the reason rather than printing the slug", () => {
    const run = buildCheckRun(audited, "none");
    expect(run.summary).toContain("The engine measured 3 violation(s)");
    expect(run.summary).not.toContain("`measured_facts_unjudged`");
  });

  it("still prints an unrecognized retraction reason verbatim", () => {
    // Gate does not enumerate the engine's reasons: one it has not heard of is
    // still a retraction, and the engine's own word is what a reader gets.
    const unknown: GateReviewResult = { ...audited, gradeUnavailableReason: "some_new_reason" };
    const run = buildCheckRun(unknown, "none");

    expect(run.conclusion).toBe("neutral");
    // Escaped, because it is engine-supplied display text like everything else
    // on this surface, but present and unparaphrased.
    expect(run.summary).toContain("some\\_new\\_reason");
  });
});

describe("T5: an unjudged run still renders the full measured block", () => {
  const unjudged: GateReviewResult = {
    ...measured,
    findings: [],
    provenance: {
      model_backed: false,
      source: "canned",
      engine: "verdict-local",
      model: null,
      detail: "no model was configured, so a deterministic stand-in filled the critique",
    },
  };

  it("withholds the grade and publishes the measurements", () => {
    const run = buildCheckRun(unjudged, "none");

    expect(run.conclusion).toBe("neutral");
    expect(run.title).toBe("Not judged");
    // The direct fix for the prose: this summary claims the measured facts are
    // real, and now the measured facts are in it.
    expect(run.summary).toContain("The capture and the measured facts are real");
    expect(run.summary).toContain("#hero-subtitle");
    expect(run.summary).toContain("text contrast 3.23:1 is below WCAG AA 4.5:1");
  });

  it("the sticky comment beside it says the same", () => {
    const comment = renderStickyComment(unjudged, { headSha: "abcdef1234567" });

    expect(comment).toContain("The page was captured and measured for real");
    expect(comment).toContain("#hero-subtitle");
  });

  it("a nothing-reviewed run publishes them too", () => {
    const nothing: GateReviewResult = {
      ...measured,
      findings: [],
      coverage: { ...measured.coverage!, routesReviewed: [], viewportsReviewed: [] },
    };
    const run = buildCheckRun(nothing, "none");

    expect(run.conclusion).toBe("neutral");
    expect(run.summary).toContain("#hero-subtitle");
  });
});

describe("a measurement is never a finding", () => {
  it("does not appear in the findings table or change the grade", () => {
    const comment = renderStickyComment(measured, { headSha: "abcdef1234567" });

    // The golden review has three real model findings; the measured block adds
    // none, and lives under its own heading.
    expect(comment).toContain("Measured, not graded");
    expect(comment).toContain("No model was involved in these");
    const run = buildCheckRun(measured, "none");
    expect(run.title).toBe("Needs work");
    expect(run.conclusion).toBe(mapCheckRunConclusion(measured.grade, "none"));
  });

  it("min_severity_to_comment cannot filter a measurement, because it has no severity", () => {
    const comment = renderStickyComment(measured, {
      headSha: "abcdef1234567",
      minSeverityToComment: "blocker",
    });

    expect(comment).toContain("#hero-subtitle");
  });

  it("rules.suppress does not reach a measurement, and vice versa", () => {
    // Two vocabularies on purpose: `suppress` mutes a MODEL finding by id or
    // element, `measurement_suppress` mutes a MEASUREMENT. Muting a judgment is
    // not the same act as muting a ruler, and one key doing both would hide the
    // second by accident.
    const comment = renderStickyComment(measured, {
      headSha: "abcdef1234567",
      suppress: ["#hero-subtitle"],
    });

    expect(comment).toContain("#hero-subtitle");
  });
});

/**
 * The one number that would reverse this decision.
 *
 * A judge that returns one unrelated nit while saying nothing about a measured
 * WCAG AA contrast failure grades `ship_with_nits`, which maps to `success`.
 * Nothing here closes that case, by choice. It is counted instead, and a
 * materially non-zero rate over real repositories is the evidence that flooring
 * the grade on measurements was right after all.
 */
describe("gate_green_over_measured", () => {
  const green: GateReviewResult = {
    ...withMeasurements(loadGoldenReviewResult(), [violation({ blockEligible: true })]),
    grade: "ship_with_nits",
    findings: [loadGoldenReviewResult().findings[2]!],
  };

  it("fires on a green check published over a block-eligible measured violation", () => {
    expect(isGreenOverMeasured(green, { conclusion: "success" })).toBe(true);
  });

  it("does not fire when the conclusion was not green", () => {
    expect(isGreenOverMeasured(green, { conclusion: "neutral" })).toBe(false);
  });

  it("does not fire when the model produced nothing: that is the retraction's case", () => {
    expect(isGreenOverMeasured({ ...green, findings: [] }, { conclusion: "success" })).toBe(false);
  });

  it("does not fire when the engine did not stand behind the measurement", () => {
    const inconclusive = withMeasurements(green, [violation({ blockEligible: false })]);
    expect(isGreenOverMeasured(inconclusive, { conclusion: "success" })).toBe(false);
  });

  it("does not fire on a violation the repo muted", () => {
    expect(
      isGreenOverMeasured(green, { conclusion: "success", suppress: ["#hero-subtitle"] }),
    ).toBe(false);
  });

  it("does not fire when nothing judged the page or the grade was retracted", () => {
    const unjudged: GateReviewResult = {
      ...green,
      provenance: { ...green.provenance!, model_backed: false },
    };
    expect(isGreenOverMeasured(unjudged, { conclusion: "success" })).toBe(false);
    expect(
      isGreenOverMeasured(
        { ...green, gradeUnavailableReason: "measured_facts_unjudged" },
        { conclusion: "success" },
      ),
    ).toBe(false);
  });
});

/**
 * Which measurements the engine will stand behind.
 *
 * `blockEligible` is the engine's own precision claim, per measurement, and the
 * advisory row used to throw it away: every row rendered identically, so a team
 * that did not build this engine could not tell a contrast failure it will gate
 * on from a `<pre>` that is wide on purpose. Under `advisory`, which is the
 * default and where this matters most, nothing about the conclusion says it
 * either.
 */
describe("the advisory row says what the engine stands behind", () => {
  const mixed = withMeasurements(loadGoldenReviewResult(), [
    violation({ blockEligible: true }),
    violation({ kind: "overflow", element: "#promo-code", blockEligible: false }),
  ]);

  it("tags every row with the engine's own eligibility, both ways", () => {
    const block = measurementBlock(mixed) ?? "";
    const rows = block.split("\n").filter((line) => line.startsWith("- "));

    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("#hero-subtitle");
    expect(rows[0]).toContain("_[block-eligible]_");
    expect(rows[1]).toContain("#promo-code");
    expect(rows[1]).toContain("_[advisory only]_");
  });

  it("summarizes the split, and says advisory mode will not act on it", () => {
    const block = measurementBlock(mixed) ?? "";

    expect(block).toContain("1 of them is **block-eligible**");
    expect(block).toContain("The other 1 is advisory only");
    expect(block).toContain("`rules.measurements: advisory` does not let it do");
  });

  it("says so plainly when the engine stands behind none of them", () => {
    const none = withMeasurements(loadGoldenReviewResult(), [violation({ blockEligible: false })]);
    const block = measurementBlock(none) ?? "";

    expect(block).toContain("None of them are block-eligible");
    expect(block).toContain("would change nothing here");
    expect(block).not.toContain("**block-eligible**");
  });

  it("drops the advisory caveat once the repo has opted into blocking", () => {
    const block = measurementBlock(mixed, { mode: "block" }) ?? "";

    expect(block).toContain("1 of them is **block-eligible**");
    expect(block).not.toContain("does not let it do");
    expect(block).toContain("will not gate on it under any configuration");
  });

  it("puts block-eligible rows first, so the display cap can never hide one", () => {
    // Twelve advisory-only rows would otherwise push the one violation the
    // engine stands behind past the cut, and the reader would never see it.
    const buried = withMeasurements(loadGoldenReviewResult(), [
      ...Array.from({ length: 14 }, (_, i) =>
        violation({ element: `#advisory-${i}`, blockEligible: false }),
      ),
      violation({ element: "#the-one-that-matters", blockEligible: true }),
    ]);
    const block = measurementBlock(buried) ?? "";
    const rows = block.split("\n").filter((line) => line.startsWith("- "));

    expect(rows).toHaveLength(MAX_MEASUREMENT_LINES);
    expect(rows[0]).toContain("#the-one-that-matters");
    expect(block).toContain("…and 3 more");
  });

  it("keeps the engine's order inside each group", () => {
    const ordered = withMeasurements(loadGoldenReviewResult(), [
      violation({ element: "#a", blockEligible: false }),
      violation({ element: "#b", blockEligible: true }),
      violation({ element: "#c", blockEligible: false }),
      violation({ element: "#d", blockEligible: true }),
    ]);
    const rows = (measurementBlock(ordered) ?? "").split("\n").filter((l) => l.startsWith("- "));

    expect(rows.map((row) => row.match(/#[a-d]/)?.[0])).toEqual(["#b", "#d", "#a", "#c"]);
  });

  it("reaches both surfaces, not just the check", () => {
    const comment = renderStickyComment(mixed, { headSha: "abcdef1234567" });
    const run = buildCheckRun(mixed, "none");

    expect(comment).toContain("_[block-eligible]_");
    expect(comment).toContain("_[advisory only]_");
    expect(run.summary).toContain("_[block-eligible]_");
    expect(run.summary).toContain("_[advisory only]_");
  });

  it("still cannot promote a measurement into a finding or a conclusion", () => {
    // Saying which ones the engine stands behind is a disclosure, not a policy
    // change: `advisory` remains the default and remains inert.
    const run = buildCheckRun(mixed, "blockers");
    expect(run.conclusion).toBe(mapCheckRunConclusion(mixed.grade, "blockers"));
  });
});

/**
 * What the delivery decision hands the counter.
 *
 * `greenOverMeasured` alone is a numerator with no denominator. The threshold
 * that reverses the measurement decision is stated as a share of GRADED runs,
 * and a repository that muted every contrast violation would report a healthy
 * zero for the wrong reason, so both of those facts ride along with it.
 */
describe("the decision carries the reversal number's context", () => {
  const completed = (result: GateReviewResult, suppress: string[] = []) =>
    decideDelivery(
      { status: "completed", result, jobId: "j" },
      { headSha: "abcdef1234567", gate: "none", measurementSuppress: suppress },
    );

  const green: GateReviewResult = {
    ...withMeasurements(loadGoldenReviewResult(), [violation({ blockEligible: true })]),
    grade: "ship_with_nits",
    findings: [loadGoldenReviewResult().findings[2]!],
  };

  it("marks a green-over-measured run as graded and green over a measurement", () => {
    const decision = completed(green);

    expect(decision.checkRun.conclusion).toBe("success");
    expect(decision.graded).toBe(true);
    expect(decision.greenOverMeasured).toBe(true);
    expect(decision.measurementKinds).toEqual(["contrast"]);
  });

  it("does not count a retracted grade in the denominator", () => {
    // A run the engine retracted can never be green over anything, and counting
    // it below the line would dilute the very number the decision named.
    const retracted: GateReviewResult = {
      ...green,
      findings: [],
      gradeUnavailableReason: "measured_facts_unjudged",
    };
    const decision = completed(retracted);

    expect(decision.checkRun.conclusion).toBe("neutral");
    expect(decision.graded).toBe(false);
    expect(decision.greenOverMeasured).toBe(false);
  });

  it("does not count an unjudged or nothing-reviewed run either", () => {
    const unjudged: GateReviewResult = {
      ...green,
      provenance: { ...green.provenance!, model_backed: false },
    };
    const nothing: GateReviewResult = {
      ...green,
      coverage: { ...green.coverage!, routesReviewed: [], viewportsReviewed: [] },
    };

    expect(completed(unjudged).graded).toBe(false);
    expect(completed(nothing).graded).toBe(false);
  });

  it("still counts a plain needs_work run: it was graded, just not green", () => {
    const decision = completed(measured);

    expect(decision.checkRun.conclusion).toBe("neutral");
    expect(decision.graded).toBe(true);
    expect(decision.greenOverMeasured).toBe(false);
  });

  it("reports what the repo muted, by kind, beside what it published", () => {
    const decision = completed(measured, ["#hero-subtitle", "touch_target:#icon-close"]);

    expect(decision.measurementKinds).toEqual(["overflow"]);
    expect(decision.suppressedMeasurementKinds).toEqual(["contrast", "touch_target"]);
  });

  it("reports nothing muted when the repo muted nothing", () => {
    expect(completed(measured).suppressedMeasurementKinds).toEqual([]);
  });
});
