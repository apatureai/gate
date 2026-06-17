import type { GateReviewResult, PublishMode, ReviewGrade } from "@gate/types";

export { buildServer } from "./app.js";
export type { BuildServerOptions } from "./app.js";

/**
 * GitHub Check Run conclusions Gate may publish. Full mapping logic is #11; this
 * scaffold establishes that the service consumes the shared contract rather than
 * redefining it, and encodes the hard invariant that reviews never fail by
 * default (TRD §7).
 */
export type CheckRunConclusion = "success" | "neutral" | "action_required";

/**
 * Map a review grade to a Check Run conclusion.
 *
 * Default (`advisory`) is never blocking: even a `blocked` grade resolves to
 * `neutral`. Only explicit `blocking` publish mode (opt-in `rules.gate`) may
 * surface `action_required`.
 */
export function gradeToCheckRunConclusion(
  grade: ReviewGrade,
  publishMode: PublishMode,
): CheckRunConclusion {
  if (publishMode === "blocking" && (grade === "blocked" || grade === "needs_work")) {
    return "action_required";
  }
  return grade === "ship" ? "success" : "neutral";
}

/** Convenience: derive the conclusion for an engine result under a publish mode. */
export function conclusionForResult(
  result: GateReviewResult,
  publishMode: PublishMode,
): CheckRunConclusion {
  return gradeToCheckRunConclusion(result.grade, publishMode);
}
