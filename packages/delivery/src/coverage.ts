import type { GateReviewResult, ReviewCoverage, Viewport } from "@gate/types";
import { sanitizeCodeSpan, sanitizeDisplayText } from "./sanitize.js";

/**
 * How much of the requested review actually happened.
 *
 * `judgment.ts` answers "did a model judge this page?". This module answers the
 * question next to it: "what did it judge?". Both are needed, and neither
 * substitutes for the other. An engine can truthfully stamp
 * `provenance.model_backed: true` for a run whose capture produced no images,
 * because a model client was configured and called; the page it was called about
 * simply does not exist. That run still arrives shaped like a clean review:
 * `grade: "ship"`, `findings: []`, and, through `mapCheckRunConclusion`, a green
 * ✅ on the surface that gates the merge.
 *
 * Three different producers reach that state:
 *   1. every route's critique failing validation (`"<route>: no valid critique"`),
 *   2. an empty capture (zero model calls on zero pixels), and
 *   3. the grounding gate dropping every finding the model emitted.
 *
 * Only the first two mean nothing was reviewed. The third is the behaviour the
 * grounding gate exists for: the routes WERE judged, and nothing the model said
 * about them could be grounded in the capture, which is a real and clean result.
 * Coverage separates them because it is reported from what the pipeline did, not
 * from what survived the pipeline.
 *
 * WHY NOT INFER THIS FROM `notReviewed`. The obvious rule, "zero findings plus a
 * non-empty `notReviewed` is not a pass", is wrong, and the golden fixture is
 * the counterexample: it skips `/checkout` and the tablet viewport and carries
 * real findings on the routes it did review. Once those findings are fixed that
 * same run legitimately becomes `ship` with zero findings and a non-empty
 * `notReviewed`, and failing it would punish an honest partial review for saying
 * what it skipped. `notReviewed` is also free prose that an engine may leave
 * empty entirely. Coverage is on the contract instead.
 */
export type CoverageState =
  /** Every requested route and viewport was reviewed. */
  | "full"
  /** Something was reviewed, but not everything that was asked for. */
  | "partial"
  /** Nothing was reviewed. Whatever grade the result carries describes nothing. */
  | "nothing"
  /** The engine did not report coverage. Not the same as "everything". */
  | "unstated";

/** Classify a result's coverage. Absent coverage is `unstated`, never assumed full. */
export function coverageState(result: GateReviewResult): CoverageState {
  const coverage = result.coverage;
  if (!coverage) return "unstated";
  if (coverage.routesReviewed.length === 0) return "nothing";
  return coversEverythingRequested(coverage) ? "full" : "partial";
}

/**
 * True when the reviewed sets account for everything requested.
 *
 * Compared as sets, and the reviewed side is allowed to be a superset: an engine
 * that reviewed a route nobody listed has still covered the ask, and calling
 * that "partial" would print a skipped-items list that is empty.
 */
function coversEverythingRequested(coverage: ReviewCoverage): boolean {
  return (
    skipped(coverage.routesRequested, coverage.routesReviewed).length === 0 &&
    skipped(coverage.viewportsRequested, coverage.viewportsReviewed).length === 0
  );
}

/** Requested items with no counterpart in the reviewed set, in requested order. */
function skipped<T>(requested: readonly T[], reviewed: readonly T[]): T[] {
  const seen = new Set(reviewed);
  return [...new Set(requested)].filter((item) => !seen.has(item));
}

/**
 * True when the grade must be suppressed because nothing was reviewed.
 *
 * Deliberately narrow: `partial` and `unstated` do NOT suppress. A partial
 * review is a real review of a smaller surface, and its grade is a real verdict
 * about what it covered. `unstated` is argued in `coverageCaveat`.
 */
export function suppressesGradeForCoverage(state: CoverageState): boolean {
  return state === "nothing";
}

/** Check Run title when the grade is suppressed because nothing was reviewed. */
export const NOTHING_REVIEWED_TITLE = "Nothing reviewed";

/** Why there is no grade, when the reason is that nothing was reviewed. */
export function nothingReviewedReason(result: GateReviewResult): string {
  const coverage = result.coverage;
  const requested = coverage ? coverage.routesRequested.length : 0;
  const routes =
    requested === 0
      ? "no routes"
      : `${requested} requested route${requested === 1 ? "" : "s"}`;
  return (
    `**No grade.** The engine reviewed nothing: 0 of ${routes} were judged on this run, ` +
    "so the result below describes no page. This run is not a pass and not a failure."
  );
}

/** The remedy line closing a Check Run whose grade was suppressed for coverage. */
export const NOTHING_REVIEWED_REMEDY =
  "A result with no findings grades `ship` by construction, which is why this is neutral " +
  "rather than green: there was nothing to find because nothing was looked at. The routes " +
  "and the reason each was skipped are listed below.";

/** Render a route/viewport list as safe code spans, bounded so a long list cannot flood the summary. */
function renderItems(items: readonly string[], max = 12): string {
  const shown = items.slice(0, max).map((item) => sanitizeCodeSpan(item, 80));
  const rest = items.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(", ");
}

/**
 * One line stating what the run covered, for every state including `unstated`.
 *
 * Always rendered, so a reader never has to infer coverage from the absence of a
 * caveat, and so the Check Run and the sticky comment cannot tell different
 * stories about the same run.
 */
export function coverageCaveat(result: GateReviewResult): string {
  const coverage = result.coverage;
  if (!coverage) {
    // ABSENT COVERAGE, THE DELIBERATE CHOICE. An older or third-party engine
    // will not send this field, and Gate does NOT flip such a run to neutral on
    // the heuristic "zero findings + a non-empty notReviewed". That heuristic
    // fails the golden fixture's honest partial (see `CoverageState`), and
    // `notReviewed` is prose an engine may never populate, so the heuristic is
    // both wrong on real results and blind on others.
    //
    // Silence here is still not allowed to publish a green tick over nothing,
    // and it does not, for two reasons that hold together:
    //   - an engine that says nothing about judgment either is `unattested` in
    //     `judgment.ts` and already loses its grade; and
    //   - an engine that DOES stamp `provenance.model_backed: true` has made the
    //     positive claim that a model was called on a capture of the requested
    //     target, which is incompatible with "nothing was reviewed". Gate acts
    //     on that claim rather than second-guessing it with an inference it has
    //     already been shown to get wrong.
    // What is left is an engine that stamps `model_backed: true` untruthfully.
    // Gate cannot detect that from the payload, so it says so in band instead of
    // implying a completeness it cannot verify.
    return (
      "📋 _Coverage:_ the engine did not report which routes and viewports it reviewed, so Gate " +
      "cannot confirm this result covers your whole UI. An engine that reports coverage states it " +
      "on the result as `coverage.routesReviewed`."
    );
  }

  const routesSkipped = skipped(coverage.routesRequested, coverage.routesReviewed);
  const viewportsSkipped: Viewport[] = skipped(
    coverage.viewportsRequested,
    coverage.viewportsReviewed,
  );
  const parts = [
    `${coverage.routesReviewed.length} of ${new Set(coverage.routesRequested).size} route(s) reviewed`,
  ];
  if (coverage.routesReviewed.length > 0) parts.push(`reviewed ${renderItems(coverage.routesReviewed)}`);
  if (routesSkipped.length > 0) parts.push(`skipped ${renderItems(routesSkipped)}`);
  if (viewportsSkipped.length > 0) parts.push(`viewports skipped: ${renderItems(viewportsSkipped)}`);
  return `📋 _Coverage:_ ${parts.join("; ")}.`;
}

/**
 * The "Not reviewed" block, or undefined when the engine skipped nothing.
 *
 * Rendered on the Check Run as well as the sticky comment (#165). Before this,
 * `notReviewed` appeared ONLY in the comment, so the two surfaces beside each
 * other could disagree about the same run and the merge-gating one was the one
 * that overstated. Engine-supplied prose, so it is sanitized and bounded like
 * every other untrusted display string Gate publishes.
 */
export function notReviewedSection(result: GateReviewResult, max = 20): string | undefined {
  const items = notReviewedItems(result, max);
  return items === undefined ? undefined : `**Not reviewed**\n\n${items}`;
}

/**
 * The skipped-item list on its own, without a heading, so each surface can title
 * it in its own voice while sharing one bound and one sanitizer. The sticky
 * comment renders it under `### Not reviewed`; the Check Run under a bold line.
 */
export function notReviewedItems(result: GateReviewResult, max = 20): string | undefined {
  const lines = result.notReviewed.filter((line) => line.trim().length > 0);
  if (lines.length === 0) return undefined;
  const shown = lines.slice(0, max).map((line) => `- ${sanitizeDisplayText(line, 300)}`);
  if (lines.length > shown.length) shown.push(`- _and ${lines.length - shown.length} more_`);
  return shown.join("\n");
}
