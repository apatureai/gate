import type { NormalizedDesignReviewConfig, Severity, Viewport } from "./config.js";
import type { ReviewDepth } from "./depth.js";

/**
 * Gate <-> judgment-engine review contract (TRD §6, amended by §15.1 and §15.2).
 *
 * This package is the single source of truth for the boundary. It deliberately
 * carries no engine implementation detail and no model-specific fields: the
 * default judge is Qwen3-VL through `judgment-engine`, and nothing here may
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
/** The engine's eight-value design rubric (judgment-engine#159), preserved verbatim. */
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
   * The engine's rubric dimension (judgment-engine#159). Gate PRESERVES this
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
   * stored before judgment-engine#150; Gate preserves but never synthesizes it.
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
     * Engine-owned capture-health footnote (Judgment Engine #20): fixed aggregate
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
