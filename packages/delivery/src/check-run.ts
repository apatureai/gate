import type { GateMode, GateReviewResult, MeasurementsMode, ReviewGrade } from "@gate/types";
import {
  coverageCaveat,
  coverageState,
  notReviewedSection,
  nothingReviewedReason,
  suppressesGradeForCoverage,
  NOTHING_REVIEWED_REMEDY,
  NOTHING_REVIEWED_TITLE,
} from "./coverage.js";
import {
  judgmentDetail,
  judgmentNoGradeReason,
  judgmentRemedy,
  judgmentState,
  judgmentTitle,
  suppressesGrade,
} from "./judgment.js";
import { baselineSection } from "./measurement-baseline-render.js";
import type { MeasurementComparison } from "./measurement-baseline.js";
import {
  blockEligibleMeasurements,
  measurementBlock,
  measurementsAreBlocking,
} from "./measurements.js";
import { sanitizeDisplayText } from "./sanitize.js";

/**
 * Check Run conclusion mapping (TRD §7.2). Default is never-blocking: a review
 * only fails the PR when the repo opts in with `rules.gate: blockers`.
 */
export type CheckRunConclusion = "success" | "neutral" | "failure";

/** Bound on the engine's narrative, matching the sticky comment's. */
const OVERALL_MAX = 2_000;

const GRADE_TITLE: Record<ReviewGrade, string> = {
  ship: "Ship",
  ship_with_nits: "Ship with nits",
  needs_work: "Needs work",
  blocked: "Blocked",
};

/**
 * Map a grade to a Check Run conclusion:
 * - ship / ship_with_nits -> success
 * - needs_work -> neutral
 * - blocked -> failure only when gate mode is `blockers`, else neutral
 */
export function mapCheckRunConclusion(grade: ReviewGrade, gate: GateMode): CheckRunConclusion {
  switch (grade) {
    case "ship":
    case "ship_with_nits":
      return "success";
    case "needs_work":
      return "neutral";
    case "blocked":
      return gate === "blockers" ? "failure" : "neutral";
  }
}

export interface CheckRunContext {
  /** Link to the sticky comment or dashboard run (TRD §7). */
  detailsUrl?: string;
  /**
   * `rules.measurements`. Defaults to `advisory`: the measured block is
   * rendered and the conclusion is untouched.
   *
   * Deliberately in this context object rather than a second positional
   * parameter, so `buildCheckRun(result, gate)` keeps its exact signature and
   * `mapCheckRunConclusion(grade, gate)` stays the only thing that turns a
   * GRADE into a conclusion.
   */
  measurements?: MeasurementsMode;
  /** `rules.measurement_suppress`: exact `element` or `"<kind>:<element>"` matches. */
  measurementSuppress?: readonly string[];
  /**
   * This run's measured violations placed against the base commit's stored set.
   *
   * When supplied, `rules.measurements: block` fails the check ONLY on
   * violations this pull request introduced. That is the difference between a
   * merge gate a team keeps and one they switch off in week one, because the
   * unscoped form fails the first pull request after installation on the
   * repository's entire back catalogue.
   *
   * Every answer that is not a usable baseline classifies nothing as introduced,
   * so it can only ever make the check LESS likely to fail, never more. Absent
   * entirely means this caller did not ask for scoping, and the conclusion is
   * computed exactly as it was before baselines existed.
   */
  baseline?: MeasurementComparison;
}

export interface CheckRun {
  name: string;
  conclusion: CheckRunConclusion;
  title: string;
  summary: string;
  detailsUrl?: string;
}

/**
 * Build the design-review Check Run for a result under the repo's gate mode.
 *
 * TWO independent conditions have to hold before the grade reaches the
 * conclusion, because a wire result carries a grade on every path and a green ✅
 * here is the claim that a design review passed.
 *
 * 1. The engine must state that a MODEL JUDGED the page (`judgment.ts`). An
 *    unjudged run, where no model was configured and a deterministic stand-in
 *    filled the critique, still arrives carrying `grade: "ship"`, and publishing
 *    that green would tell a reader their UI passed a review that never
 *    happened. A run whose engine said nothing either way is treated the same.
 *
 * 2. The engine must have REVIEWED SOMETHING (`coverage.ts`). A model can be
 *    called on a capture that produced no images, or return a critique that
 *    fails validation for every route; both leave `grade: "ship"`,
 *    `findings: []`, and an honest `provenance.model_backed: true`. If nothing
 *    was reviewed there is no grade, whatever the payload says.
 *
 * Either failure makes the run neutral, titled for which one it was, with the
 * reason in place of the grade. What does NOT suppress the grade is a partial
 * review: covering 1 of 2 routes cleanly is a real verdict about that route, and
 * the summary names what was skipped rather than withholding the result.
 *
 * `notReviewed` is rendered on this surface no matter which branch runs, so the
 * Check Run and the sticky comment beside it can no longer disagree about what
 * this run touched.
 */
export function buildCheckRun(
  result: GateReviewResult,
  gate: GateMode,
  ctx: CheckRunContext = {},
): CheckRun {
  const state = judgmentState(result);
  const coverage = coverageState(result);
  const nothingReviewed = suppressesGradeForCoverage(coverage);
  // The engine can retract its own grade for a reason coverage cannot express.
  // The case that reached a pull request as a green Ship: every model finding
  // deleted before it could be reported, on a route that WAS reviewed, so
  // coverage is full and truthful while the grade means nothing.
  const gradeRetracted = (result.gradeUnavailableReason ?? "").length > 0;
  const graded = !suppressesGrade(state) && !nothingReviewed && !gradeRetracted;
  const measurementsMode = ctx.measurements ?? "advisory";
  // The ONLY path in this system where a measurement changes a conclusion, and
  // it exists only because a repo owner wrote `rules.measurements: block` in
  // their own `.gate.yml`. Same shape as `rules.gate: blockers`, and for the
  // same reason: the engine does not block on its own authority, and neither
  // does the vendor default. Only ENGINE-marked block-eligible violations count,
  // and a suppressed one has already been removed.
  // ...and, when the caller scoped this run against the base commit, only on
  // violations this pull request INTRODUCED. Everything else about the mapping
  // below is unchanged; the scoping can only ever remove a reason to fail.
  const blocking = measurementsAreBlocking(
    result,
    measurementsMode,
    ctx.measurementSuppress ?? [],
    ctx.baseline,
  );
  // Never `success`, never `failure` from a grade that was suppressed: an
  // ungraded run is not a pass, and it is not the repo's PR failing either.
  // `blocking` is the one thing that overrides that, and it is repo policy
  // rather than a judgment: when a repo has said "never merge this measured
  // defect", an explicit answer beats "no grade".
  const conclusion: CheckRunConclusion = blocking
    ? "failure"
    : graded
      ? mapCheckRunConclusion(result.grade, gate)
      : "neutral";
  // Coverage wins the title when both are suppressed. "Nothing reviewed" is the
  // stronger and more actionable statement: an operator whose capture produced
  // no pages is not helped by being told the judgment stamp was missing too.
  const title = blocking
    ? "Measured violations"
    : graded
      ? GRADE_TITLE[result.grade]
      : nothingReviewed
        ? NOTHING_REVIEWED_TITLE
        : gradeRetracted
          ? "No usable grade"
          : judgmentTitle(state);

  const summaryParts: string[] = [];
  // FIRST, when a measurement failed this check: a reader who opens a red check
  // reads the top of the summary, and every other opening line here is about the
  // grade. Under `block` the grade may be a perfectly good `Ship`, so leading
  // with it would make the failure look unexplained, or worse, look like the
  // model's verdict. Name the cause and name the setting that chose it, so the
  // one person who can change the outcome knows which line of `.gate.yml` to
  // open. "on their own" is exact: the grade may or may not also be failing,
  // and this sentence claims only what these measurements are sufficient for.
  if (blocking) {
    // Counted from the SAME set that produced the conclusion. When this run was
    // scoped against the base commit that is the introduced, block-eligible
    // violations and nothing else, so the number a reader is given is the number
    // of things they can fix here rather than the size of the back catalogue.
    const gating = ctx.baseline
      ? ctx.baseline.introduced.filter((violation) => violation.blockEligible)
      : blockEligibleMeasurements(result, ctx.measurementSuppress ?? []);
    summaryParts.push(
      `**Failed by measurement.** ${gating.length} block-eligible measurement(s) ` +
        `${ctx.baseline ? "introduced by this pull request " : ""}below are enough to ` +
        "fail this check on their own, because this repository sets " +
        "`rules.measurements: block`. No model was involved in producing them. Set " +
        "`rules.measurements: advisory` to keep seeing them without failing on them.",
    );
  }
  if (graded) {
    // The narrative is model prose, and a Check Run summary is Markdown too: it
    // is sanitized here for the same reason the sticky comment sanitizes it.
    summaryParts.push(`**Grade:** ${GRADE_TITLE[result.grade]}`, sanitizeDisplayText(result.overall, OVERALL_MAX));
  } else if (gradeRetracted && !nothingReviewed) {
    // Say what the engine said, not a paraphrase: it knows why it retracted and
    // Gate does not enumerate the reasons. The one reason Gate DOES word is the
    // one whose slug is opaque and whose consequence is the sharpest: a judge
    // that was handed measured facts about this page and returned nothing.
    summaryParts.push(
      result.gradeUnavailableReason === "measured_facts_unjudged"
        ? "**No grade.** The engine measured " +
            `${result.measurements?.violations.length ?? 0} violation(s) on the route(s) it ` +
            "reviewed, and the review returned no findings at all. A judge that is handed " +
            "measured facts and returns nothing has not reviewed this page, so this run is not " +
            "a pass and not a failure."
        : "**No grade.** The engine reported that its grade is not a verdict about this page " +
            `(\`${sanitizeDisplayText(result.gradeUnavailableReason ?? "", 120)}\`). ` +
            "This run is not a pass and not a failure.",
    );
    if (result.overall.trim().length > 0) {
      summaryParts.push(sanitizeDisplayText(result.overall, OVERALL_MAX));
    }
  } else if (nothingReviewed) {
    summaryParts.push(nothingReviewedReason(result));
    // When the engine ALSO could not attest a judgment, say so: it is the more
    // likely root cause of an empty run, and the remedies differ.
    if (suppressesGrade(state)) {
      const detail = judgmentDetail(result);
      if (detail) summaryParts.push(sanitizeDisplayText(detail, 600));
    }
    summaryParts.push(NOTHING_REVIEWED_REMEDY);
  } else {
    const detail = judgmentDetail(result);
    summaryParts.push(judgmentNoGradeReason(state));
    if (detail) summaryParts.push(sanitizeDisplayText(detail, 600));
    summaryParts.push(judgmentRemedy(state));
  }
  // The measured half, on EVERY path: graded, unjudged, nothing-reviewed and
  // grade-retracted alike. A measurement is true whether or not a model ran, and
  // on the paths where the grade is withheld it is the only thing on this check
  // a reader can act on. This is also what finally makes `judgmentRemedy`'s
  // "the measured facts are real" a statement with something behind it.
  const measured = measurementBlock(result, {
    mode: measurementsMode,
    suppress: ctx.measurementSuppress ?? [],
    ...(ctx.baseline ? { baseline: ctx.baseline } : {}),
  });
  if (measured) summaryParts.push(measured);
  // Whose violations those are. Directly under the measured block, because its
  // most important output is the one where it has nothing to report: "no
  // baseline, so nothing here could be shown to be new" has to sit next to the
  // list it is talking about, or it reads as a footnote to a clean result.
  if (ctx.baseline) {
    const scoped = baselineSection(ctx.baseline, { mode: measurementsMode, blocking });
    if (scoped) summaryParts.push(scoped);
  }
  // What this run covered, on every path including "the engine did not say".
  summaryParts.push(coverageCaveat(result));
  // What the engine skipped, in its own words. Rendered here as well as in the
  // sticky comment so the merge-gating surface cannot be the quieter of the two.
  const skipped = notReviewedSection(result);
  if (skipped) summaryParts.push(skipped);
  // Informational capture-health caveat (Verdict #20), bounded + sanitized. Never
  // changes the conclusion; that is `mapCheckRunConclusion(grade)` alone.
  // "Zero findings" and "three findings, none of which could be grounded" both
  // arrive as an empty list under a `ship` grade. Only the engine knows which
  // happened, so say it rather than letting the reader assume the first.
  if (result.hallucinationDrops !== undefined && result.hallucinationDrops > 0) {
    summaryParts.push(
      `🧹 _Grounding:_ ${result.hallucinationDrops} model finding(s) were deleted for citing a route ` +
        "or element the capture never produced, so they are not shown above.",
    );
  }
  const health = result.artifacts.pageHealthFootnote;
  if (health !== undefined && health.trim().length > 0) {
    summaryParts.push(`🩺 _Capture health:_ ${sanitizeDisplayText(health, 280)}`);
  }
  if (ctx.detailsUrl) summaryParts.push(`[View the full review](${ctx.detailsUrl})`);
  return {
    name: "Apature Gate",
    conclusion,
    title,
    summary: summaryParts.join("\n\n"),
    detailsUrl: ctx.detailsUrl,
  };
}
