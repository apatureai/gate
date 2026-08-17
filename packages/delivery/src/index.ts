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
  notReviewedItems,
  nothingReviewedReason,
  NOTHING_REVIEWED_TITLE,
  NOTHING_REVIEWED_REMEDY,
} from "./coverage.js";
export type { CoverageState } from "./coverage.js";
export {
  MAX_MEASUREMENT_LINES,
  blockEligibleMeasurements,
  gateableMeasurements,
  isGreenOverMeasured,
  measurementBlock,
  measurementLine,
  measurementsAreBlocking,
  suppressMeasurements,
  visibleMeasurements,
} from "./measurements.js";
export type { MeasurementBlockOptions } from "./measurements.js";
export {
  MEASUREMENT_IDENTITY_VERSION,
  detailSubstance,
  measurementDefectKey,
  measurementElementKey,
  measurementFingerprint,
  measurementIdentity,
  normalizeElement,
  normalizeRoute,
} from "./measurement-identity.js";
export type { MeasurementIdentity } from "./measurement-identity.js";
export {
  buildMeasurementBaseline,
  compareMeasurementsToBaseline,
  createInMemoryMeasurementBaselineStore,
  lookupMeasurementBaseline,
  measuredKinds,
  measuredRoutes,
} from "./measurement-baseline.js";
export type {
  BuildBaselineOptions,
  ClassifiedMeasurement,
  CompareMeasurementsOptions,
  MeasurementBaselineEntry,
  MeasurementBaselineKey,
  MeasurementBaselineLookup,
  MeasurementBaselineRecord,
  MeasurementBaselineSnapshot,
  MeasurementBaselineStatus,
  MeasurementBaselineStore,
  MeasurementComparison,
  MeasurementOrigin,
  UnclassifiedReason,
} from "./measurement-baseline.js";
export { BASELINE_SECTION_HEADING, baselineSection } from "./measurement-baseline-render.js";
export { mapCheckRunConclusion, buildCheckRun } from "./check-run.js";
export type { CheckRunConclusion, CheckRunContext, CheckRun } from "./check-run.js";
export {
  setupFailureCheckRun,
  engineNotConfiguredCheckRun,
  engineEndpointInvalidCheckRun,
} from "./setup-failure.js";
export type { MalformedEndpointFacts } from "./setup-failure.js";
export {
  sanitizeDisplayText,
  sanitizeCodeSpan,
  safeLinkUrl,
  escapeTableCell,
} from "./sanitize.js";
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
