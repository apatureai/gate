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
export { mapCheckRunConclusion, buildCheckRun } from "./check-run.js";
export type { CheckRunConclusion, CheckRunContext, CheckRun } from "./check-run.js";
export { setupFailureCheckRun } from "./setup-failure.js";
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
