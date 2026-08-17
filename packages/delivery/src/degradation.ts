import type { PollOutcome } from "@gate/engine";
import type { Finding, GateMode, MeasurementsMode, Severity } from "@gate/types";
import { buildCheckRun, type CheckRunConclusion } from "./check-run.js";
import { coverageState, suppressesGradeForCoverage, type CoverageState } from "./coverage.js";
import { judgmentState, suppressesGrade, type JudgmentState } from "./judgment.js";
import { isGreenOverMeasured, visibleMeasurements } from "./measurements.js";
import { sanitizeCodeSpan } from "./sanitize.js";
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
  | "circuit_open"
  /** The critique service rejected the request itself (auth, tenant, route). */
  | "engine_rejected"
  /** The idempotency key was already spent on a different request body. */
  | "idempotency_conflict";

export interface DeliveryDecision {
  /** Whether to publish a findings comment (false for degraded states). */
  publishComment: boolean;
  reason?: DegradationReason;
  checkRun: { conclusion: CheckRunConclusion; title: string; summary: string };
  /** Sticky comment body when a result is published. */
  comment?: string;
  /** Confidence caveat surfaced to the user, if any. */
  caveat?: string;
  /**
   * Whether the engine says a model judged this page. Present on every completed
   * outcome so the run record and the logs carry the same fact the comment does:
   * a `reviewed` status with `judgment: "unjudged"` is not a review.
   */
  judgment?: JudgmentState;
  /**
   * How much of the requested review actually happened (verdict#165). Present on
   * every completed outcome, for the same reason `judgment` is: a `reviewed`
   * status logged beside a neutral Check Run would be the very
   * two-surfaces-disagree bug this field exists to close, so the run record
   * carries the fact as well as the comment.
   */
  coverage?: CoverageState;
  /**
   * A green check published over a measured violation the engine stood behind.
   *
   * The counter that prices the case this design deliberately does not close: a
   * judge that returns one unrelated nit and says nothing about a measured WCAG
   * AA failure still grades green. Carried on the decision so a caller with a
   * meter records exactly what was published, rather than recomputing it from
   * fields and drifting.
   */
  greenOverMeasured?: boolean;
  /** Measured violations rendered on the PR surfaces, by kind, for the SLOs. */
  measurementKinds?: string[];
}

export interface DegradationContext {
  headSha: string;
  gate: GateMode;
  /** `rules.min_severity_to_comment`: findings below it are omitted from the comment. */
  minSeverityToComment?: Severity;
  /** `rules.suppress`: findings whose id/element matches an entry are omitted from the comment. */
  suppress?: string[];
  /**
   * `rules.measurements`. Default `advisory`: the engine's measured facts are
   * rendered on both surfaces and never change the Check Run conclusion. Only
   * `block`, which a repo owner sets explicitly, lets an engine-marked
   * block-eligible violation fail the check.
   */
  measurements?: MeasurementsMode;
  /** `rules.measurement_suppress`: exact `element` or `"<kind>:<element>"` matches. */
  measurementSuppress?: readonly string[];
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
  engine_rejected: "Review not submitted",
  idempotency_conflict: "Review not submitted (duplicate key)",
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
  const judgment = judgmentState(result);
  const coverage = coverageState(result);
  // An unjudged run, or one that reviewed nothing, publishes no findings at all,
  // so "N findings were dropped" would be reporting on a list nobody will see.
  const graded = !suppressesGrade(judgment) && !suppressesGradeForCoverage(coverage);

  const caveats: string[] = [];
  if (graded && dropped > 0) {
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
    measurements: ctx.measurements,
    measurementSuppress: ctx.measurementSuppress,
  });
  const checkRun = buildCheckRun(result, ctx.gate, {
    detailsUrl: ctx.runUrl,
    measurements: ctx.measurements,
    measurementSuppress: ctx.measurementSuppress,
  });

  return {
    publishComment: true,
    comment,
    caveat,
    judgment,
    coverage,
    greenOverMeasured: isGreenOverMeasured(result, {
      conclusion: checkRun.conclusion,
      suppress: ctx.measurementSuppress ?? [],
    }),
    measurementKinds: visibleMeasurements(result, ctx.measurementSuppress ?? []).map(
      (violation) => violation.kind,
    ),
    checkRun: { conclusion: checkRun.conclusion, title: checkRun.title, summary: checkRun.summary },
  };
}

/** Reasons that exist before any result does, so they never carry a comment. */
export type PreResultFailureReason =
  | "engine_unavailable"
  | "circuit_open"
  | "engine_rejected"
  | "idempotency_conflict";

/**
 * What the engine itself said, when it said anything. Only the machine-readable
 * code and the HTTP status cross into the Check Run: both are short, both are
 * Gate-formatted, and neither carries engine prose onto a pull request.
 */
export interface EngineErrorFacts {
  code?: string | null;
  status?: number | null;
}

/**
 * What to check, per engine error code. Every one of these is a real code from
 * the reference service's wire (`packages/api/src/hmac.ts`, `server.ts`), so the
 * advice names the variable that is actually wrong rather than guessing.
 */
const REJECTION_HINTS: Record<string, string> = {
  signature_mismatch:
    "`GATE_ENGINE_HMAC_SECRET` does not match the critique service's own `ENGINE_HMAC_SECRET`. The two values have to be identical.",
  missing_signature:
    "The request reached the service unsigned. Set `GATE_ENGINE_HMAC_SECRET` on the workflow step.",
  missing_installation:
    "The request reached the service without its installation header, so it was not signed. Set `GATE_ENGINE_HMAC_SECRET` on the workflow step.",
  timestamp_skew:
    "The signature timestamp was outside the service's accepted window. Check the clock on the runner and on the service.",
  not_found:
    "The endpoint answered, but serves no job API at that path. Check that `GATE_ENGINE_ENDPOINT` is the service's base URL.",
  method_not_allowed:
    "The endpoint answered, but serves no job API at that path. Check that `GATE_ENGINE_ENDPOINT` is the service's base URL.",
  invalid_submission:
    "The service rejected the request body as malformed, which means Gate and the service disagree about the contract. Check that both are on compatible versions.",
  invalid_json:
    "The service rejected the request body as malformed, which means Gate and the service disagree about the contract. Check that both are on compatible versions.",
  schema_version_mismatch:
    "The service returned a result on a schema version Gate does not accept, so Gate and the service are on incompatible majors. Upgrade whichever is older; a retry sends the same request and gets the same answer.",
  missing_schema_version:
    "The service returned a result with no schema version header, so Gate cannot tell whether the contract matches. Check that `GATE_ENGINE_ENDPOINT` points at a job API that stamps `x-schema-version`.",
};

const DEFAULT_REJECTION_HINT =
  "Check `GATE_ENGINE_ENDPOINT` and `GATE_ENGINE_HMAC_SECRET` on the workflow step.";

/**
 * A success status that is not the job API's 202 means the URL answered, but
 * whatever answered is not a job API: a landing page, a proxy, a health check.
 * That is the likeliest mistake after a wrong secret, and it used to be reported
 * as a temporary outage because it is not a 4xx.
 */
const WRONG_ENDPOINT_HINT =
  "The endpoint answered, but did not accept the job. `GATE_ENGINE_ENDPOINT` is probably not the critique service's base URL: a landing page, a proxy or a health check will answer without serving a job API.";

function rejectionHint(facts: EngineErrorFacts): string {
  const byCode = REJECTION_HINTS[facts.code ?? ""];
  if (byCode) return byCode;
  const status = facts.status ?? null;
  if (status !== null && status >= 200 && status < 300) return WRONG_ENDPOINT_HINT;
  return DEFAULT_REJECTION_HINT;
}

/**
 * `` `HTTP 401 signature_mismatch` ``, as a closed code span, or nothing when the
 * engine said neither.
 *
 * A code span, not escaped prose: the operator's job here is to match this
 * string against their service's logs, and an error code carries underscores
 * that inline escaping would render as `signature\_mismatch`. Inside a span the
 * backslash is literal, so the only thing that has to be neutralized is the
 * backtick that would close it early, which is what `sanitizeCodeSpan` does.
 */
function engineReply(facts: EngineErrorFacts): string | null {
  const parts: string[] = [];
  if (typeof facts.status === "number") parts.push(`HTTP ${facts.status}`);
  if (facts.code) parts.push(facts.code);
  return parts.length > 0 ? sanitizeCodeSpan(parts.join(" "), 120) : null;
}

/**
 * Map an engine error raised before a result exists to a neutral Check Run.
 *
 * The PR is never failed, but "Gate will retry" is only said where it is true.
 * A rejected request and a spent idempotency key are permanent until a human
 * changes something, and the summary for those names the engine's own code and
 * what to do about it, because the operator is the only one who can clear it.
 */
export function decideDeliveryForError(
  reason: PreResultFailureReason,
  facts: EngineErrorFacts = {},
): DeliveryDecision {
  const reply = engineReply(facts);
  const replyLine = reply ? `\n\nThe critique service answered ${reply}.` : "";

  switch (reason) {
    case "circuit_open":
      return neutral(
        reason,
        "The design engine is temporarily unavailable and Gate has paused calls; it will retry automatically.",
      );
    case "engine_rejected":
      return neutral(
        reason,
        "Gate reached the critique service, and the service rejected the request. No review was " +
          `submitted and the PR is not blocked.${replyLine}\n\n` +
          `${rejectionHint(facts)}\n\n` +
          "This one does not clear by itself: the next push sends the same request to the same " +
          "endpoint with the same credentials, so Gate is not promising a retry that would fix it.",
      );
    case "idempotency_conflict":
      return neutral(
        reason,
        "Gate reached the critique service, and the service refused the job because the " +
          "idempotency key for this pull request and head SHA was already spent on a " +
          `different request. No review was submitted and the PR is not blocked.${replyLine}\n\n` +
          "The usual cause is a preview redeploy: the head SHA did not change, but the preview " +
          "URL did, so the request body no longer matches the one the key was issued for. Push a " +
          "commit to review the new preview, or re-run once the preview URL has settled.\n\n" +
          "This one does not clear by itself either: the key stays spent until the head SHA " +
          "changes.",
      );
    case "engine_unavailable":
    default:
      return neutral(
        reason,
        `The design engine is temporarily unavailable. The PR is not blocked; Gate will retry.${replyLine}`,
      );
  }
}
