import type { GateReviewResult } from "@gate/types";

/**
 * Did anything actually judge this page?
 *
 * A wire result always carries a `grade`, on every path. When the engine has no
 * model configured it still captures the page for real, still computes the
 * deterministic facts for real, and then fills the critique from a deterministic
 * stand-in. The result of that run is byte-shaped exactly like a clean review:
 * `grade: "ship"`, `findings: []`. Mapped through `buildCheckRun` it becomes a
 * green ✅ Ship, and a reader has no way to tell that nothing looked at their UI.
 *
 * That is the failure this module exists to make impossible. Gate reads the
 * engine's own statement and, unless it says a model judged the capture, refuses
 * to let the grade speak: the Check Run goes neutral and the sticky comment
 * leads with the disclosure instead of a verdict.
 *
 * The unjudged result is still published, because it is not worthless: the
 * capture, the geometry map and the measured contrast/overflow/touch-target
 * facts in it are real. Only the grade, the narrative and the findings are not a
 * judgment of the page, and only those are suppressed.
 */

/** The stable prefix verdict puts on its own "nothing judged this" disclosure. */
export const NO_MODEL_DISCLOSURE_PREFIX = "[verdict] no model judged this page";

export type JudgmentState =
  /** The engine states a model judged a capture of the requested target. */
  | "model_backed"
  /** The engine states nothing judged the page (no model configured, or a stand-in ran). */
  | "unjudged"
  /** The engine ran a model but cannot confirm it judged this target. */
  | "unconfirmed"
  /** The engine said nothing either way: a producer that predates the stamp. */
  | "unattested";

/**
 * Classify a result. Reads the structural stamp first, then falls back to the
 * prose disclosure, which verdict documents as a stable grep target: a producer
 * that emits the sentence but not the struct is still telling Gate the truth,
 * and Gate is not entitled to ignore it because it arrived in the other field.
 */
export function judgmentState(result: GateReviewResult): JudgmentState {
  const disclosed = result.notReviewed.some((line) =>
    line.startsWith(NO_MODEL_DISCLOSURE_PREFIX),
  );
  const provenance = result.provenance;
  if (!provenance) return disclosed ? "unjudged" : "unattested";
  if (provenance.model_backed === false) return "unjudged";
  if (provenance.model_backed === null) return "unconfirmed";
  // An explicit `true` that contradicts its own disclosure line is resolved
  // against the grade, never in favour of it.
  return disclosed ? "unjudged" : "model_backed";
}

/** True when the grade in this result is a verdict about the page Gate captured. */
export function isJudged(result: GateReviewResult): boolean {
  return judgmentState(result) === "model_backed";
}

/**
 * True when the grade must be suppressed: the engine either knows nothing judged
 * the page, or ran something it cannot attribute to this target. `unattested`
 * is deliberately NOT in this set. It is the pre-stamp wire shape, indistinguish-
 * able from a legacy engine that judges perfectly well, and Gate's schema
 * contract is additive-only, so treating silence as a confession would neutralize
 * every conforming engine that has not adopted the field yet. Silence still gets
 * a visible caveat (see `judgmentCaveat`); it just does not eat the grade.
 */
export function suppressesGrade(state: JudgmentState): boolean {
  return state === "unjudged" || state === "unconfirmed";
}

/** Engine's own sentence about the run, when it supplied one. */
export function judgmentDetail(result: GateReviewResult): string | undefined {
  const detail = result.provenance?.detail?.trim();
  if (detail) return detail;
  return result.notReviewed.find((line) => line.startsWith(NO_MODEL_DISCLOSURE_PREFIX));
}

/** Title for a Check Run whose grade was suppressed. */
export function judgmentTitle(state: JudgmentState): string {
  return state === "unconfirmed" ? "Judgment unconfirmed" : "Not judged";
}

/** One-line banner replacing the grade wherever a grade would have been shown. */
export function judgmentBanner(state: JudgmentState): string {
  return state === "unconfirmed"
    ? "⚠️ **Judgment unconfirmed**: the engine could not confirm that a model judged this page, so no grade is shown."
    : "⚠️ **Not judged**: no model judged this page, so there is no grade and no findings to trust.";
}

/**
 * The caveat a published result carries about its own judgment. `unattested`
 * is the only state that reaches the comment with its grade intact, so it is the
 * only state that needs a caveat rather than a banner.
 */
export function judgmentCaveat(state: JudgmentState): string | undefined {
  if (state !== "unattested") return undefined;
  return "The engine did not state whether a model judged this page, so its grade is unverified.";
}

/**
 * What the version-lineage footer should say about the model. `metadata.model`
 * is the model the engine is CONFIGURED to route to, which it stamps whether or
 * not a call was made; on an unjudged run printing it bare reads as an
 * attribution. `provenance.model` is the model that was actually called.
 */
export function footerModel(result: GateReviewResult): string {
  const state = judgmentState(result);
  if (!suppressesGrade(state)) return result.metadata.model;
  const configured = result.metadata.model;
  return `${configured} (not called; nothing judged this page)`;
}
