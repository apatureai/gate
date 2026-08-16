import type { GateMode, GateReviewResult, ReviewGrade } from "@gate/types";
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
import { sanitizeDisplayText } from "./sanitize.js";

/**
 * Check Run conclusion mapping (TRD §7.2). Default is never-blocking: a review
 * only fails the PR when the repo opts in with `rules.gate: blockers`.
 */
export type CheckRunConclusion = "success" | "neutral" | "failure";

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
  const graded = !suppressesGrade(state) && !nothingReviewed;
  // Never `success`, never `failure`: an ungraded run is not a pass, and it is
  // not the repo's PR failing either.
  const conclusion: CheckRunConclusion = graded
    ? mapCheckRunConclusion(result.grade, gate)
    : "neutral";
  // Coverage wins the title when both are suppressed. "Nothing reviewed" is the
  // stronger and more actionable statement: an operator whose capture produced
  // no pages is not helped by being told the judgment stamp was missing too.
  const title = graded
    ? GRADE_TITLE[result.grade]
    : nothingReviewed
      ? NOTHING_REVIEWED_TITLE
      : judgmentTitle(state);

  const summaryParts: string[] = [];
  if (graded) {
    summaryParts.push(`**Grade:** ${GRADE_TITLE[result.grade]}`, result.overall);
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
  // What this run covered, on every path including "the engine did not say".
  summaryParts.push(coverageCaveat(result));
  // What the engine skipped, in its own words. Rendered here as well as in the
  // sticky comment so the merge-gating surface cannot be the quieter of the two.
  const skipped = notReviewedSection(result);
  if (skipped) summaryParts.push(skipped);
  // Informational capture-health caveat (Verdict #20), bounded + sanitized. Never
  // changes the conclusion; that is `mapCheckRunConclusion(grade)` alone.
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
