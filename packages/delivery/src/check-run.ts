import type { GateMode, GateReviewResult, ReviewGrade } from "@gate/types";
import {
  judgmentCaveat,
  judgmentDetail,
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
 * The grade only reaches the conclusion when the engine says a model judged the
 * page. An unjudged run (no model configured, so a deterministic stand-in filled
 * the critique) still arrives carrying `grade: "ship"`; publishing that as a
 * green ✅ would tell a reader their UI passed a review that never happened. Such
 * a run is neutral, titled for what it is, and its summary opens with the
 * engine's own disclosure instead of a grade.
 */
export function buildCheckRun(
  result: GateReviewResult,
  gate: GateMode,
  ctx: CheckRunContext = {},
): CheckRun {
  const state = judgmentState(result);
  const graded = !suppressesGrade(state);
  // Never `success`, never `failure`: an ungraded run is not a pass, and it is
  // not the repo's PR failing either.
  const conclusion: CheckRunConclusion = graded
    ? mapCheckRunConclusion(result.grade, gate)
    : "neutral";
  const title = graded ? GRADE_TITLE[result.grade] : judgmentTitle(state);

  const summaryParts: string[] = [];
  if (graded) {
    summaryParts.push(`**Grade:** ${GRADE_TITLE[result.grade]}`, result.overall);
  } else {
    const detail = judgmentDetail(result);
    summaryParts.push(
      "**No grade.** Gate captured the page and the engine measured it, but nothing judged it, " +
        "so this run is not a pass and not a failure.",
    );
    if (detail) summaryParts.push(sanitizeDisplayText(detail, 600));
    summaryParts.push(
      "The capture and the measured facts are real. The grade, the narrative and any findings " +
        "the engine returned are not a judgment of this page and are withheld. Configure a model " +
        "on your engine to get a reviewed run.",
    );
  }
  const caveat = judgmentCaveat(state);
  if (caveat) summaryParts.push(`⚠️ _${caveat}_`);
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
