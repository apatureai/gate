import type { GateReviewResult, Measurement, MeasurementsMode } from "@gate/types";
import { sanitizeCodeSpan, sanitizeDisplayText } from "./sanitize.js";

/**
 * The MEASURED half of a review, on the surfaces a pull request actually shows.
 *
 * Gate's own Check Run prose has told readers, for as long as the unjudged path
 * has existed, that "the capture and the measured facts are real". It was not a
 * white lie, it was a claim with nothing behind it: the engine contract had no
 * field for a measured fact, `contract.ts` is deliberately non-`.strict()` so
 * anything unnamed is stripped, and Gate had therefore never received one. A
 * reader was being told a result was backed by something that never arrived.
 *
 * This module is the other half of closing that. A measurement is a contrast
 * ratio, a scroll width or a rectangle the engine computed from the captured
 * DOM. No model produced it, nothing calibrated it, and it is true whether or
 * not a judge ever ran. That is exactly why it is rendered on EVERY path,
 * including the unjudged one, the nothing-reviewed one and the retracted-grade
 * one, where a reader currently gets nothing actionable at all.
 *
 * What it never does, unless the repo says so in `.gate.yml`: change a Check Run
 * conclusion. The grade stays a pure function of the model's surviving findings,
 * a measurement is never rendered as a finding, and a `blockEligible: false`
 * violation can never set a conclusion under any configuration.
 */

/** Measured groups listed before the block is cut short (matches the CLI's cap). */
export const MAX_MEASUREMENT_LINES = 12;

/** Display bounds for the engine-supplied strings in a measured row. */
const ELEMENT_MAX = 160;
const DETAIL_MAX = 240;
const ROUTE_MAX = 120;

const KIND_LABEL: Record<Measurement["kind"], string> = {
  contrast: "contrast",
  overflow: "overflow",
  touch_target: "target size",
};

/**
 * Drop measurements the repo muted with `rules.measurement_suppress`.
 *
 * An entry matches a violation when it exactly equals the violation's `element`
 * or its `"<kind>:<element>"` form. Exact, never glob or regex: pattern
 * semantics are undefined in the config contract, so an ambiguous match is never
 * guessed. Same rule and same rationale as `suppressFindings`.
 *
 * Suppression removes a violation from rendering AND from block eligibility.
 * It cannot reach the ENGINE's grade retraction, which is computed engine-side
 * from what was measured and never reads a repository's configuration: a repo
 * key that could silence the one signal an injected page cannot reach would
 * itself be a second injection channel.
 */
export function suppressMeasurements(
  violations: readonly Measurement[],
  suppress: readonly string[] = [],
): Measurement[] {
  if (suppress.length === 0) return [...violations];
  const muted = new Set(suppress);
  return violations.filter(
    (violation) => !muted.has(violation.element) && !muted.has(`${violation.kind}:${violation.element}`),
  );
}

/** The measurements this result carries, after the repo's own suppression. */
export function visibleMeasurements(
  result: GateReviewResult,
  suppress: readonly string[] = [],
): Measurement[] {
  return suppressMeasurements(result.measurements?.violations ?? [], suppress);
}

/**
 * The unsuppressed violations the ENGINE marked as precise enough to gate on.
 *
 * Gate never computes this flag and never overrides it. `blockEligible: false`
 * is the engine saying a measurement may be intentional (a deliberate scroll
 * container, a desktop pointer target) or may fall in a known false-positive
 * class (text over a background image). Gate's only job is to refuse to fail a
 * build on one.
 */
export function blockEligibleMeasurements(
  result: GateReviewResult,
  suppress: readonly string[] = [],
): Measurement[] {
  return visibleMeasurements(result, suppress).filter((violation) => violation.blockEligible);
}

/** Count violations by kind, in a stable order, for the block's header line. */
function countByKind(violations: readonly Measurement[]): string {
  const order: Array<Measurement["kind"]> = ["contrast", "overflow", "touch_target"];
  const counts = new Map<Measurement["kind"], number>();
  for (const violation of violations) {
    counts.set(violation.kind, (counts.get(violation.kind) ?? 0) + 1);
  }
  return order
    .filter((kind) => counts.has(kind))
    .map((kind) => `${KIND_LABEL[kind]} ${counts.get(kind) as number}`)
    .join(", ");
}

/**
 * The per-row eligibility tag.
 *
 * `blockEligible` is the ENGINE's own precision claim about one measurement, and
 * until now the advisory block threw it away: every row rendered identically, so
 * a reader could not tell a 3.23:1 contrast failure the engine will stand behind
 * from a `<pre>` that is wide on purpose. Both are true measurements. Only one of
 * them is something the engine is willing to fail a build on, and a team that did
 * not build this engine has no other way to learn which.
 *
 * Deliberately the engine's word, not a severity: `advisory only` says the engine
 * will not gate on this one, and says nothing about whether it is worth fixing.
 */
const ELIGIBILITY_TAG: Record<"true" | "false", string> = {
  true: "_[block-eligible]_",
  false: "_[advisory only]_",
};

/**
 * Block-eligible rows first.
 *
 * The list is capped at `MAX_MEASUREMENT_LINES`, so an unsorted block could push
 * the one violation the engine stands behind past the cut in favour of twelve it
 * does not. A stable sort keeps the engine's order within each group.
 */
function blockEligibleFirst(violations: readonly Measurement[]): Measurement[] {
  return [...violations].sort((a, b) => Number(b.blockEligible) - Number(a.blockEligible));
}

/**
 * One measured row. Every cell is engine-supplied and therefore untrusted
 * display text: the model's prose is not the only string on this surface a pull
 * request author can influence, since a selector comes off their own DOM.
 *
 * The eligibility tag is the one cell Gate writes itself, from a boolean it never
 * computes and never overrides.
 */
function measurementLine(violation: Measurement): string {
  return (
    `- \`[${KIND_LABEL[violation.kind]}]\` ${sanitizeCodeSpan(violation.route, ROUTE_MAX)} ` +
    `${sanitizeCodeSpan(violation.element, ELEMENT_MAX)} ` +
    `(${violation.viewports.map((viewport) => sanitizeDisplayText(viewport, 40)).join(", ")}) — ` +
    `${sanitizeDisplayText(violation.detail, DETAIL_MAX)} ` +
    ELIGIBILITY_TAG[violation.blockEligible ? "true" : "false"]
  );
}

/**
 * The sentence that tells a reader which of these the engine stands behind.
 *
 * Rendered under `advisory` as well as under `block`, because the whole point is
 * that a reader can see the engine's confidence BEFORE their repository decides
 * what to do with it. Under `advisory` nothing here fails anything, and the
 * sentence says so in the same breath.
 */
function eligibilitySummary(violations: readonly Measurement[], blocking: boolean): string {
  const eligible = violations.filter((violation) => violation.blockEligible).length;
  const advisory = violations.length - eligible;
  if (eligible === 0) {
    return (
      `None of them are block-eligible: the engine reports them and will not stand behind any of ` +
      `them for failing a check, so \`rules.measurements: block\` would change nothing here.`
    );
  }
  const stands =
    `${eligible} of them ${eligible === 1 ? "is" : "are"} **block-eligible**: ` +
    `${eligible === 1 ? "a measurement" : "measurements"} the engine will stand behind for failing a check` +
    (blocking ? "." : ", which this repository's `rules.measurements: advisory` does not let it do.");
  if (advisory === 0) return stands;
  return (
    `${stands} The other ${advisory} ${advisory === 1 ? "is" : "are"} advisory only: the engine ` +
    `reports ${advisory === 1 ? "it" : "them"} and will not gate on ${advisory === 1 ? "it" : "them"} ` +
    `under any configuration.`
  );
}

export interface MeasurementBlockOptions {
  /** `rules.measurements`; defaults to `advisory`. */
  mode?: MeasurementsMode;
  /** `rules.measurement_suppress`. */
  suppress?: readonly string[];
  /** Whether `block` mode is failing the check, which changes the heading. */
  blocking?: boolean;
}

/**
 * The measured block, or `null` when this result carries no measurements at all.
 *
 * `off` does not render silently. It renders one line saying measurements
 * arrived and are not being shown, because a setting that makes a surface
 * quietly drop evidence is worse than a surface that is noisy: the reader would
 * have no way to tell "nothing was measured" from "your repo told me not to say".
 */
export function measurementBlock(
  result: GateReviewResult,
  options: MeasurementBlockOptions = {},
): string | null {
  const report = result.measurements;
  if (report === undefined) return null;
  const mode = options.mode ?? "advisory";
  const visible = suppressMeasurements(report.violations, options.suppress ?? []);

  if (mode === "off") {
    if (report.violations.length === 0) return null;
    return (
      `📏 _Measurement reporting is disabled by repo config (\`rules.measurements: off\`); ` +
      `${report.violations.length} measurement(s) were received and are not shown._`
    );
  }
  if (visible.length === 0) return null;

  const ordered = blockEligibleFirst(visible);
  const shown = ordered.slice(0, MAX_MEASUREMENT_LINES);
  const remaining = ordered.length - shown.length;
  const heading = options.blocking
    ? `📏 **Measured violations** — ${visible.length} violation(s) computed from the captured DOM ` +
      `(${countByKind(visible)}). This repository sets \`rules.measurements: block\`.`
    : `📏 **Measured, not graded** — ${visible.length} violation(s) computed from the captured DOM ` +
      `(${countByKind(visible)}).`;

  const lines = [
    heading,
    eligibilitySummary(visible, options.blocking ?? false),
    shown.map(measurementLine).join("\n"),
  ];
  if (remaining > 0) lines.push(`…and ${remaining} more`);
  lines.push(
    options.blocking
      ? "No model was involved in these. They did not affect the grade; this repository's own " +
        "configuration is what turned them into a failing check."
      : "No model was involved in these. They do not affect the grade.",
  );
  return lines.join("\n\n");
}

/**
 * The counter that prices the hole this design deliberately leaves open.
 *
 * A judge that returns one unrelated nit while saying nothing about a measured
 * WCAG AA contrast failure grades `ship_with_nits`, which maps to `success`.
 * Green tick, with the violation printed underneath it. The retraction cannot
 * catch that case, because the judge spoke; nothing here closes it, by choice,
 * because closing it means asserting a severity for "3.23:1" that no threshold
 * in WCAG supplies.
 *
 * So it is counted instead. A materially non-zero rate over real repositories is
 * the evidence that flooring the grade on measurements was the right call after
 * all, and it is the one number that would reverse this decision.
 *
 * Deliberately narrow: it fires only when a model really judged the page, really
 * produced findings, and the engine really stood behind at least one measured
 * violation the repo did not mute. Every one of those conditions removes a way
 * of counting a run that is not the case being priced.
 */
export function isGreenOverMeasured(
  result: GateReviewResult,
  options: { conclusion: string; suppress?: readonly string[] },
): boolean {
  if (options.conclusion !== "success") return false;
  if (result.provenance?.model_backed !== true) return false;
  if ((result.gradeUnavailableReason ?? "").length > 0) return false;
  if ((result.coverage?.routesReviewed.length ?? 0) === 0) return false;
  if (result.findings.length === 0) return false;
  return blockEligibleMeasurements(result, options.suppress ?? []).length > 0;
}
