export {
  STICKY_MARKER,
  renderStickyComment,
  findingsAtOrAbove,
  suppressFindings,
  upsertStickyComment,
} from "./sticky-comment.js";
export type {
  StickyCommentContext,
  IssueComment,
  GitHubCommentsApi,
  UpsertOutcome,
} from "./sticky-comment.js";
export {
  NO_MODEL_DISCLOSURE_PREFIX,
  judgmentState,
  isJudged,
  suppressesGrade,
  judgmentDetail,
  judgmentTitle,
  judgmentBanner,
  judgmentNoGradeReason,
  judgmentRemedy,
  footerModel,
} from "./judgment.js";
export type { JudgmentState } from "./judgment.js";
export {
  coverageState,
  suppressesGradeForCoverage,
  coverageCaveat,
  notReviewedSection,
  nothingReviewedReason,
  NOTHING_REVIEWED_TITLE,
  NOTHING_REVIEWED_REMEDY,
} from "./coverage.js";
export type { CoverageState } from "./coverage.js";
export { mapCheckRunConclusion, buildCheckRun } from "./check-run.js";
export type { CheckRunConclusion, CheckRunContext, CheckRun } from "./check-run.js";
export {
  setupFailureCheckRun,
  engineNotConfiguredCheckRun,
  engineEndpointInvalidCheckRun,
} from "./setup-failure.js";
export type { MalformedEndpointFacts } from "./setup-failure.js";
export { sanitizeDisplayText } from "./sanitize.js";
export { validateFindings, decideDelivery, decideDeliveryForError } from "./degradation.js";
export type {
  DegradationReason,
  DeliveryDecision,
  DegradationContext,
  EngineErrorFacts,
  FindingValidation,
  PreResultFailureReason,
} from "./degradation.js";
export { buildAnnotationSvg, annotateScreenshot } from "./annotate.js";
export type { Rect, Annotation } from "./annotate.js";
export {
  createInMemoryBaselineStore,
  buildComparisonPairs,
  buildBeforeAfterArtifact,
} from "./baseline.js";
export type { CaptureRef, BaselineStore, ComparisonPair, BeforeAfterArtifact } from "./baseline.js";
