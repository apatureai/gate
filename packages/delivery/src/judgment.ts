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
 *
 * A result that says NOTHING about its own judgment is treated the same way, as
 * of 2026-08-15. See `suppressesGrade` for why that reversed.
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
 *
 * That fallback matches one vendor's literal sentence, so it can only ever
 * REFINE `unattested` into the more specific `unjudged`. It is not what keeps a
 * silent engine from publishing a green Ship; `suppressesGrade` is, and it turns
 * on the contract-level `provenance` field alone.
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
 * True when the grade must be suppressed: the engine did not state, in a way
 * Gate can read, that a model judged this page.
 *
 * `unattested` is in this set as of 2026-08-15, reversing the earlier rule that
 * let silence keep its grade.
 *
 * The old rule read silence as "probably a pre-stamp engine that judges fine"
 * and published the grade with a caveat. That was only ever safe because the
 * fallback below also matched the reference engine's prose disclosure, whose
 * literal text begins `[verdict] no model judged this page`: a brand string.
 * Every OTHER contract-conforming engine, having no `provenance` field and no
 * reason to emit another vendor's sentence, landed in `unattested`, kept its
 * grade, and published `conclusion: "success"`, `title: "Ship"`. So the
 * repository's stated non-negotiable, that a run nothing judged is never shown
 * as a pass, held only for the one engine written alongside Gate, and inverted
 * for every third party. A guarantee with that shape is not a guarantee.
 *
 * Silence is now read as "not stated", which is what it is. The cost is real
 * and accepted: an engine that judges with a model but does not stamp
 * `provenance` gets a neutral Check Run instead of a green one. That is the
 * recoverable direction of the error, it is one additive field to fix, and the
 * Check Run says exactly which field. Being wrong the other way publishes a
 * green Ship over a page nothing looked at, which is not recoverable at all
 * because nobody goes back to check a passing review.
 */
export function suppressesGrade(state: JudgmentState): boolean {
  return state === "unjudged" || state === "unconfirmed" || state === "unattested";
}

/** Engine's own sentence about the run, when it supplied one. */
export function judgmentDetail(result: GateReviewResult): string | undefined {
  const detail = result.provenance?.detail?.trim();
  if (detail) return detail;
  return result.notReviewed.find((line) => line.startsWith(NO_MODEL_DISCLOSURE_PREFIX));
}

/** Title for a Check Run whose grade was suppressed. */
export function judgmentTitle(state: JudgmentState): string {
  switch (state) {
    case "unconfirmed":
      return "Judgment unconfirmed";
    case "unattested":
      return "Judgment not stated";
    default:
      return "Not judged";
  }
}

/** One-line banner replacing the grade wherever a grade would have been shown. */
export function judgmentBanner(state: JudgmentState): string {
  switch (state) {
    case "unconfirmed":
      return "⚠️ **Judgment unconfirmed**: the engine could not confirm that a model judged this page, so no grade is shown.";
    case "unattested":
      return "⚠️ **Judgment not stated**: the engine did not say whether a model judged this page, so no grade is shown.";
    default:
      return "⚠️ **Not judged**: no model judged this page, so there is no grade and no findings to trust.";
  }
}

/**
 * Why there is no grade, and what would change that, in the engine's terms.
 *
 * Split by state because the three suppressed states are three different facts,
 * and collapsing them into "nothing judged it" would tell an operator whose
 * engine simply omits one field that their model never ran.
 */
export function judgmentNoGradeReason(state: JudgmentState): string {
  switch (state) {
    case "unattested":
      return (
        "**No grade.** Gate captured the page and the engine measured it, but the engine did not " +
        "state whether a model judged it, so this run is not a pass and not a failure."
      );
    case "unconfirmed":
      return (
        "**No grade.** Gate captured the page and the engine measured it, but the engine could " +
        "not confirm that what it ran judged this target, so this run is not a pass and not a failure."
      );
    default:
      return (
        "**No grade.** Gate captured the page and the engine measured it, but nothing judged it, " +
        "so this run is not a pass and not a failure."
      );
  }
}

/** The remedy line that closes a no-grade Check Run summary. */
export function judgmentRemedy(state: JudgmentState): string {
  const withheld =
    "The capture and the measured facts are real. The grade, the narrative and any findings " +
    "the engine returned are withheld, because Gate cannot show them as a judgment of this page. ";
  return state === "unattested"
    ? `${withheld}An engine that did call a model states so in band, with \`provenance.model_backed: true\` on the result; Gate publishes a grade once it does.`
    : `${withheld}Configure a model on your engine to get a reviewed run.`;
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
  // Silence is not evidence the model was skipped, only that nobody said.
  return state === "unattested"
    ? `${configured} (configured; the engine did not state whether it was called)`
    : `${configured} (not called; nothing judged this page)`;
}
