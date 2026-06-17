export {
  STICKY_MARKER,
  renderStickyComment,
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
export { validateFindings, decideDelivery, decideDeliveryForError } from "./degradation.js";
export type { DegradationReason, DeliveryDecision, DegradationContext, FindingValidation } from "./degradation.js";
