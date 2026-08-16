import type { NormalizedDesignReviewConfig, Severity, Viewport } from "./config.js";
import type { ReviewDepth } from "./depth.js";

/**
 * Gate <-> verdict review contract (TRD §6, amended by §15.1 and §15.2).
 *
 * This package is the single source of truth for the boundary. It deliberately
 * carries no engine implementation detail and no model-specific fields: the
 * default judge is Qwen3-VL through `verdict`, and nothing here may
 * hard-code Claude or any other model.
 */

/** Overall verdict for a PR review. */
export type ReviewGrade = "ship" | "ship_with_nits" | "needs_work" | "blocked";

/** How Gate intends to publish the result on the PR. */
export type PublishMode = "advisory" | "blocking";

export type ConfidenceSource =
  | "raw_verbalized"
  | "post_hoc_isotonic"
  | "post_hoc_histogram"
  | "hidden_state_probe"
  | "ensemble";

/** Exact promoted report that authorizes display confidence. */
export type ConfidenceCalibrationReference = {
  reportId: string;
  reportHash: `sha256:${string}`;
  calibrationVersion: string;
  confidenceSource: ConfidenceSource;
};

export type ConfidenceUnavailableReason =
  | "missing_calibration_report"
  | "invalid_calibration_report"
  | "mismatched_calibration_report"
  | "insufficient_evidence"
  | "unattested_calibration_report";

/** A single design-review finding produced by the engine. */
/** The engine's eight-value design rubric (verdict#159), preserved verbatim. */
export type Dimension =
  | "visual_hierarchy"
  | "spacing"
  | "color_contrast"
  | "typography"
  | "consistency"
  | "responsiveness"
  | "accessibility"
  | "brand";

export type Finding = {
  /** Stable id within a run; used to key annotated screenshots and feedback. */
  id: string;
  severity: Severity;
  /**
   * The engine's rubric dimension (verdict#159). Gate PRESERVES this
   * additive field through the contract even though the current renderer does
   * not display it; Gate never synthesizes it. Optional only so results stored
   * before the field existed still type-check.
   */
  dimension?: Dimension;
  title: string;
  description: string;
  /** Route the finding was observed on. */
  route: string;
  viewport: Viewport;
  /** Best-effort element reference (selector/role), or null when not localizable. */
  element: string | null;
  /** Id of the annotated screenshot for this finding, or null. */
  screenshotId: string | null;
  /** Suggested remediation, or null. */
  suggestion: string | null;
  /**
   * Engine-produced calibrated confidence in [0, 1]. Optional only for results
   * stored before verdict#150; Gate preserves but never synthesizes it.
   */
  confidence?: number;
};

/**
 * Build/runtime diagnostics extracted from a locally-served preview's output
 * (#70 U1). When Gate runs the repo's preview-command, its compiler/dev-server
 * output (failed compiles, hydration warnings, missing assets) is parsed into
 * these facts and passed to the engine so the critique is grounded in the
 * build's own truth, not just pixels. Engine consumption is additive; absent for
 * hosted-preview reviews.
 */
export type PreviewBuildFactKind = "compile_error" | "warning" | "asset_error" | "hydration" | "deprecation";
export type PreviewBuildFact = { kind: PreviewBuildFactKind; message: string; source?: string };

export type GateReviewRequest = {
  installationId: string;
  repository: {
    owner: string;
    name: string;
    defaultBranch: string;
  };
  pullRequest: {
    number: number;
    headSha: string;
    baseSha: string;
    title: string;
    body: string | null;
  };
  preview: {
    url: string;
    provider: "vercel" | "netlify" | "cloudflare" | "render" | "explicit" | "local";
    environment: string | null;
  };
  config: NormalizedDesignReviewConfig;
  publishMode: PublishMode;
  /** Review depth; added by §15.1 async job contract. */
  depth: ReviewDepth;
  /** Build/runtime diagnostics from a local-serve preview (#70 U1); additive. */
  previewBuildFacts?: PreviewBuildFact[];
};

/**
 * What the engine's run actually looked at (verdict#165), stated structurally.
 *
 * Gate needs this because a wire result always carries a `grade`, and a result
 * with zero surviving findings always grades `ship` (verdict floors the grade to
 * what the surviving findings support, and nothing supports better than `ship`).
 * That is correct for a genuinely clean page and INDISTINGUISHABLE, field for
 * field, from a run that judged nothing: an empty capture, or a run where every
 * route's critique failed validation. Mapped through `buildCheckRun` all of them
 * become a green ✅ on the merge-gating surface.
 *
 * `notReviewed` cannot close that gap, and the golden fixture is the proof: it
 * skips `/checkout` and the tablet viewport while carrying real findings on what
 * it did review. A rule of "zero findings plus a non-empty `notReviewed` is not
 * a pass" would punish that run for being honest about a partial, and
 * `notReviewed` is free prose a producer may leave empty besides. Coverage is a
 * different question, asked of the contract rather than inferred from prose.
 *
 * Identifiers rather than counts, so the Check Run can NAME what was skipped.
 * Optional and additive under schema v1 (like `pageHealthFootnote` and
 * `provenance`): a producer that cannot answer honestly omits the field, and
 * Gate must read absence as "not stated", never as "everything was reviewed".
 */
export type ReviewCoverage = {
  /** Routes the review was asked to cover. */
  routesRequested: string[];
  /** Routes the run actually formed a judgment about. Empty ⇒ nothing was reviewed. */
  routesReviewed: string[];
  /** Viewports the review was asked to cover. */
  viewportsRequested: Viewport[];
  /** Viewports actually captured and judged, across the reviewed routes. */
  viewportsReviewed: Viewport[];
};

export type GateReviewResult = {
  grade: ReviewGrade;
  overall: string;
  /**
   * Engine-owned aggregate confidence in [0, 1]. Gate currently keeps this out
   * of PR rendering, but preserves it for audit, feedback, and dashboard use.
   */
  confidence?: number;
  /** Exact promoted calibration artifact for every numeric confidence. */
  calibration?: ConfidenceCalibrationReference;
  /** Explicit engine promotion mode; Gate never derives this from a score. */
  blockingEnabled?: boolean;
  /** Why confidence was withheld on a current fail-closed result. */
  confidenceUnavailableReason?: ConfidenceUnavailableReason;
  findings: Finding[];
  /** Routes/viewports/previews skipped; surfaced in the sticky comment (TRD §7). */
  notReviewed: string[];
  artifacts: {
    annotatedScreenshots: Array<{ findingId: string; url: string }>;
    /**
     * Internal engine debug link (§15.2). Gate builds its own public `runUrl`
     * from the `runs` record so the PR comment never depends on engine URLs.
     */
    engineDebugUrl?: string;
    /**
     * Engine-owned capture-health footnote (Verdict #20): fixed aggregate
     * prose about console errors, failed requests, blocked/substituted fonts, or
     * visual instability during capture. INFORMATIONAL ONLY: Gate renders it as a
     * caveat and never lets it change grade, severity, or the Check Run
     * conclusion. Treated as untrusted display text before GitHub publication.
     */
    pageHealthFootnote?: string;
  };
  /**
   * Retention window for screenshots (§15.2). After
   * `receivedAt + screenshotRetentionSeconds`, `/i/<id>.png` serves a tombstone.
   */
  screenshotRetentionSeconds: number;
  metadata: {
    engineVersion: string;
    /** The judge model the engine used (e.g. Qwen3-VL). Not hard-coded by Gate. */
    model: string;
    promptVersion: string;
    captureVersion: string;
    /** Closed design-rubric identity used by the calibration report. */
    rubricVersion?: string;
    /** Version of the repo's UI DNA the critique was grounded in, or null. */
    uiDnaVersion: string | null;
  };
  /**
   * What the run actually looked at (verdict#165), additive + optional under
   * schema v1. Absent means "this producer does not report coverage", never
   * "everything was reviewed". Gate reads it in `coverageState()` and refuses to
   * render a grade when nothing was reviewed. See `ReviewCoverage`.
   */
  coverage?: ReviewCoverage;
  /**
   * Whether anything actually judged the page, stated by the engine in the
   * payload (additive + optional under schema v1, like `pageHealthFootnote`).
   *
   * A wire result always carries a `grade`, including on the paths where the
   * critique came from a mock or canned client because no model was configured.
   * Without this stamp those two cases are byte-identical to a clean review, and
   * Gate would publish a green "Ship" for a page nothing looked at. Gate reads
   * it in `judgmentState()` and refuses to render a grade unless
   * `model_backed === true`.
   */
  provenance?: JudgmentProvenance;
};

/**
 * The engine's in-band answer to "did a model judge this page?" Field names are
 * snake_case because this object is emitted verbatim by the engine
 * (apatureai/verdict `packages/types/src/provenance.ts`) and rides out to
 * agent-facing consumers unchanged.
 */
export type JudgmentProvenance = {
  /**
   * `true` only when a model was called on a capture of the requested target;
   * `false` when the producer knows nothing judged the page; `null` when it
   * cannot tell. Anything other than `true` is "not judged" for Gate.
   */
  model_backed: boolean | null;
  /** `model` (a model was called), `canned`/`fixture` (a stand-in), `unknown`. */
  source: "model" | "canned" | "fixture" | "unknown";
  /** Which engine surface produced the result, e.g. `verdict-http`. */
  engine: string;
  /** The judge model, when one was called. `null` on every other path. */
  model: string | null;
  /** One sentence a human can read in a log with no other context. */
  detail: string;
};

const CONFIDENCE_SOURCES: readonly ConfidenceSource[] = [
  "raw_verbalized",
  "post_hoc_isotonic",
  "post_hoc_histogram",
  "hidden_state_probe",
  "ensemble",
];

/**
 * The only safe confidence-display guard. Legacy numbers remain parseable but
 * are unavailable without exact, well-formed report provenance.
 */
export function hasDisplayableConfidence(
  result: GateReviewResult,
): result is GateReviewResult & {
  confidence: number;
  calibration: ConfidenceCalibrationReference;
  findings: Array<Finding & { confidence: number }>;
} {
  const calibration = result.calibration;
  return (
    calibration != null &&
    typeof calibration.reportId === "string" &&
    calibration.reportId.length > 0 &&
    typeof calibration.reportHash === "string" &&
    /^sha256:[0-9a-f]{64}$/.test(calibration.reportHash) &&
    typeof calibration.calibrationVersion === "string" &&
    calibration.calibrationVersion.length > 0 &&
    typeof calibration.confidenceSource === "string" &&
    (CONFIDENCE_SOURCES as readonly string[]).includes(calibration.confidenceSource) &&
    result.confidenceUnavailableReason === undefined &&
    Array.isArray(result.findings) &&
    result.findings.length > 0 &&
    typeof result.confidence === "number" &&
    Number.isFinite(result.confidence) &&
    result.confidence >= 0 &&
    result.confidence <= 1 &&
    result.findings.every(
      (finding) =>
        finding !== null &&
        typeof finding === "object" &&
        typeof finding.confidence === "number" &&
        Number.isFinite(finding.confidence) &&
        finding.confidence >= 0 &&
        finding.confidence <= 1,
    )
  );
}
