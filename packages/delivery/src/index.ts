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
  judgmentCaveat,
  footerModel,
} from "./judgment.js";
export type { JudgmentState } from "./judgment.js";
export { mapCheckRunConclusion, buildCheckRun } from "./check-run.js";
export type { CheckRunConclusion, CheckRunContext, CheckRun } from "./check-run.js";
export { setupFailureCheckRun, engineNotConfiguredCheckRun } from "./setup-failure.js";
export { sanitizeDisplayText } from "./sanitize.js";
export { validateFindings, decideDelivery, decideDeliveryForError } from "./degradation.js";
export type { DegradationReason, DeliveryDecision, DegradationContext, FindingValidation } from "./degradation.js";
export { buildAnnotationSvg, annotateScreenshot } from "./annotate.js";
export type { Rect, Annotation } from "./annotate.js";
export {
  createInMemoryBaselineStore,
  buildComparisonPairs,
  buildBeforeAfterArtifact,
} from "./baseline.js";
export type { CaptureRef, BaselineStore, ComparisonPair, BeforeAfterArtifact } from "./baseline.js";
