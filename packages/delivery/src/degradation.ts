import type { PollOutcome } from "@gate/engine";
import type { Finding, GateMode, Severity } from "@gate/types";
import { buildCheckRun, type CheckRunConclusion } from "./check-run.js";
import { renderStickyComment } from "./sticky-comment.js";

/**
 * Engine failure & degradation policy (ARCHITECTURE §6; TRD §7). Every
 * engine-side failure maps to a safe, non-blocking Gate behavior: a failed or
 * degraded call never fails the PR and never publishes a misleading review.
 * Assumes the publish-time SHA guard has already confirmed the result is current
 * (no stale/partial result is published).
 */
export type DegradationReason =
  | "review_timed_out"
  | "engine_failed"
  | "engine_unavailable"
  | "circuit_open";

export interface DeliveryDecision {
  /** Whether to publish a findings comment (false for degraded states). */
  publishComment: boolean;
  reason?: DegradationReason;
  checkRun: { conclusion: CheckRunConclusion; title: string; summary: string };
  /** Sticky comment body when a result is published. */
  comment?: string;
  /** Confidence caveat surfaced to the user, if any. */
  caveat?: string;
}

export interface DegradationContext {
  headSha: string;
  gate: GateMode;
  /** `rules.min_severity_to_comment`: findings below it are omitted from the comment. */
  minSeverityToComment?: Severity;
  /** `rules.suppress`: findings whose id/element matches an entry are omitted from the comment. */
  suppress?: string[];
  runUrl?: string;
  /** Capture-instability signal from engine result metadata. */
  captureUnstable?: boolean;
  /** Validator for element references; unresolvable refs are dropped. */
  isValidElement?: (selector: string) => boolean;
}

export interface FindingValidation {
  valid: Finding[];
  dropped: number;
}

/**
 * Keep only findings with usable element references. A null element is a
 * page-level finding (kept); an empty/invalid selector is dropped so a broken
 * reference is never published.
 */
export function validateFindings(
  findings: Finding[],
  isValidElement?: (selector: string) => boolean,
): FindingValidation {
  const valid = findings.filter((f) => {
    if (f.element === null) return true;
    if (f.element.trim() === "") return false;
    return isValidElement ? isValidElement(f.element) : true;
  });
  return { valid, dropped: findings.length - valid.length };
}

const NEUTRAL_TITLES: Record<DegradationReason, string> = {
  review_timed_out: "Review timed out",
  engine_failed: "Review unavailable",
  engine_unavailable: "Review unavailable",
  circuit_open: "Review paused",
};

function neutral(reason: DegradationReason, summary: string): DeliveryDecision {
  // Never fail the PR: degraded states are always a neutral Check Run.
  return {
    publishComment: false,
    reason,
    checkRun: { conclusion: "neutral", title: NEUTRAL_TITLES[reason], summary },
  };
}

/** Map a completed-or-not poll outcome to a delivery decision. */
export function decideDelivery(outcome: PollOutcome, ctx: DegradationContext): DeliveryDecision {
  if (outcome.status === "timed_out") {
    return neutral(
      "review_timed_out",
      "The design review timed out before finishing. The PR is not blocked; Gate will retry on the next push.",
    );
  }
  if (outcome.status === "failed") {
    return neutral(
      "engine_failed",
      "The design review could not complete. The PR is not blocked; Gate will retry on the next push.",
    );
  }

  // Completed: publish only validated findings, with caveats when degraded.
  const { valid, dropped } = validateFindings(outcome.result.findings, ctx.isValidElement);
  const result = { ...outcome.result, findings: valid };

  const caveats: string[] = [];
  if (dropped > 0) {
    caveats.push(`${dropped} finding(s) referenced elements that couldn't be validated and were omitted.`);
  }
  if (ctx.captureUnstable) {
    caveats.push("Capture was unstable on this run; treat visual findings as lower-confidence.");
  }
  const caveat = caveats.length > 0 ? caveats.join(" ") : undefined;

  const comment = renderStickyComment(result, {
    headSha: ctx.headSha,
    runUrl: ctx.runUrl,
    captureCaveat: caveat,
    minSeverityToComment: ctx.minSeverityToComment,
    suppress: ctx.suppress,
  });
  const checkRun = buildCheckRun(result, ctx.gate, { detailsUrl: ctx.runUrl });

  return {
    publishComment: true,
    comment,
    caveat,
    checkRun: { conclusion: checkRun.conclusion, title: checkRun.title, summary: checkRun.summary },
  };
}

/**
 * Map an engine error raised before a result exists (unavailable, circuit-breaker
 * open) to a neutral, retry-guidance Check Run. The PR is never failed.
 */
export function decideDeliveryForError(
  reason: "engine_unavailable" | "circuit_open",
): DeliveryDecision {
  return neutral(
    reason,
    reason === "circuit_open"
      ? "The design engine is temporarily unavailable and Gate has paused calls; it will retry automatically."
      : "The design engine is temporarily unavailable. The PR is not blocked; Gate will retry.",
  );
}
