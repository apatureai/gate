import type { GateMode, GateReviewResult, ReviewGrade } from "@gate/types";
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

/** Build the design-review Check Run for a result under the repo's gate mode. */
export function buildCheckRun(
  result: GateReviewResult,
  gate: GateMode,
  ctx: CheckRunContext = {},
): CheckRun {
  const conclusion = mapCheckRunConclusion(result.grade, gate);
  const summaryParts = [`**Grade:** ${GRADE_TITLE[result.grade]}`, result.overall];
  // Informational capture-health caveat (JE #20), bounded + sanitized. Never
  // changes the conclusion — that is `mapCheckRunConclusion(grade)` alone.
  const health = result.artifacts.pageHealthFootnote;
  if (health !== undefined && health.trim().length > 0) {
    summaryParts.push(`🩺 _Capture health:_ ${sanitizeDisplayText(health, 280)}`);
  }
  if (ctx.detailsUrl) summaryParts.push(`[View the full review](${ctx.detailsUrl})`);
  return {
    name: "Apature Gate",
    conclusion,
    title: GRADE_TITLE[result.grade],
    summary: summaryParts.join("\n\n"),
    detailsUrl: ctx.detailsUrl,
  };
}
