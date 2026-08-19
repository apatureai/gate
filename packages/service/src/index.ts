export { buildServer } from "./app.js";
export type { BuildServerOptions, WebhookHandlers } from "./app.js";
export { createAppServer } from "./app-server.js";
export type { AppServerDeps } from "./app-server.js";
export { createProductionAppServer } from "./production-server.js";
export type {
  ProductionAppServer,
  ProductionAppServerDeps,
  InstallationClients,
} from "./production-server.js";
export { runStartupChecks } from "./startup.js";
export type { StartupCheckDeps } from "./startup.js";
export { PRODUCTION_ENV_VARS, checkRequiredEnv, assertProductionEnv } from "./production-readiness.js";
export type { EnvCheckResult } from "./production-readiness.js";
export { createWebhookVerifier } from "./webhooks.js";
export type { WebhookVerifier } from "./webhooks.js";
export { createGitHubAppAuth } from "./app-auth.js";
export type { GitHubAppAuth, GitHubAppAuthOptions } from "./app-auth.js";
export {
  GATE_APP_PERMISSIONS,
  GATE_APP_EVENTS,
  assertNoContentsWrite,
  buildAppManifest,
} from "./app-permissions.js";
export type { GateAppPermissions, AppManifestOptions } from "./app-permissions.js";
export { resolveDeploymentPreview, filterAppDeployments, vercelBypassHeaders } from "./deployment-preview.js";
export type {
  DeploymentStatusEvent,
  DeploymentPreviewOptions,
  DeploymentPreviewResult,
} from "./deployment-preview.js";
export {
  REVIEW_QUEUE_NAME,
  reviewQueueKey,
  createReviewQueue,
} from "./queue.js";
export type { ReviewJobPayload, QueueLike, ReviewQueue } from "./queue.js";
export { createBullReviewQueue } from "./queue-bull.js";
export {
  CancellationRegistry,
  createInMemoryReviewWorker,
  createBullReviewWorker,
} from "./worker.js";
export type { JobContext, ReviewJobHandler, ReviewJobWorker } from "./worker.js";
export {
  currentShaKey,
  createInMemorySupersessionStore,
  createRedisSupersessionStore,
  recordEnqueue,
  isCurrentSha,
  guardPublish,
} from "./supersession.js";
export type { SupersessionStore, RedisLike, RepoPr } from "./supersession.js";
export { READINESS_CEILING_MS, waitForReadiness } from "./readiness.js";
export type { ReadinessResult, ReadinessOptions } from "./readiness.js";
export {
  TIER_CONCURRENCY,
  tierConcurrency,
  selectNextJobs,
  createInMemoryCounterStore,
  InstallationConcurrency,
} from "./scheduling.js";
export type { Tier, PendingJob, SelectOptions, CounterStore } from "./scheduling.js";
export {
  FULL_REVIEW_WINDOW_MS,
  chooseReviewDepth,
  decideDepthForPush,
  createInMemoryFullReviewWindow,
  createSqlFullReviewWindow,
} from "./review-window.js";
export type { FullReviewWindowStore, SqlQuery } from "./review-window.js";
export { decideReviewDepth, recordFullReviewIfDeep, traceDepthDecision } from "./depth-policy.js";
export type { DepthReason, DepthDecision } from "./depth-policy.js";
export { createInMemoryWebhookDedupe, createSqlWebhookDedupe } from "./webhook-dedup.js";
export type { WebhookDedupeStore } from "./webhook-dedup.js";
export { isRateLimited, rateLimitDelayMs, withRateLimitRetry } from "./rate-limit.js";
export type { RateLimitRetryOptions } from "./rate-limit.js";
export {
  mintFeedbackToken,
  verifyFeedbackToken,
  createInMemoryConsumedStore,
  createSqlConsumedStore,
} from "./feedback-token.js";
export type { FeedbackVotePayload, VerifyTokenResult, ConsumedTokenStore } from "./feedback-token.js";
export { registerFeedbackRoutes, parseDesignReviewCommand } from "./feedback-routes.js";
export type { FeedbackSink, FeedbackRouteOptions, SlashCommand } from "./feedback-routes.js";
export {
  buildFeedbackEvent,
  extractSuggestionTokens,
  detectSuggestionAdoption,
  createInMemoryFeedbackStore,
  createSqlFeedbackStore,
  createHttpFeedbackForwarder,
  createFeedbackSink,
} from "./feedback-store.js";
export type {
  FeedbackEventContext,
  FeedbackStore,
  SharedFeedbackForwarder,
} from "./feedback-store.js";
export { runHostedReview, createDeploymentStatusHandler, createAppWebhookHandlers } from "./hosted-review.js";
export type {
  HostedReviewContext,
  HostedReviewDeps,
  HostedReviewStatus,
  HostedReviewResult,
  DeploymentHandlerDeps,
} from "./hosted-review.js";
export { hydrateReviewContext } from "./hydrate.js";
export type { PullRequestDetails, PullRequestFetcher } from "./hydrate.js";
export { createGitHubPullsClient } from "./github-pulls.js";
export type { GitHubPullsClient, CommitTreeReader } from "./github-pulls.js";
export { createGitHubRepositoryClient } from "./github-repository.js";
export type { DefaultBranchHead, RepositoryHeadReader } from "./github-repository.js";
export {
  recordDefaultBranchBaseline,
  measureDefaultBranchBaseline,
  parseDefaultBranchPush,
  fillDefaultBranchUrl,
} from "./default-branch-baseline.js";
export type {
  DefaultBranchTarget,
  DefaultBranchBaselineDeps,
  DefaultBranchBaselineOutcome,
  PushSkipReason,
} from "./default-branch-baseline.js";
export {
  INSTALLATION_BASELINE_CONCURRENCY,
  parseInstallationScope,
  recordInstallationBaselines,
} from "./installation-baseline.js";
export type {
  InstallationBaselineDeps,
  InstallationBaselineOutcome,
  InstallationEventName,
  InstallationRepository,
  InstallationSkipReason,
  RepositoryBaselineResult,
} from "./installation-baseline.js";
export { carryBaselineOnMerge } from "./baseline-carry-forward.js";
export type {
  BaselineCarryForwardDeps,
  BaselineCarryOutcome,
  CarrySkipReason,
  MergeCommitTreeReader,
} from "./baseline-carry-forward.js";
export { createGitHubComponentLibraryClient, createGitHubRepoConfigClient } from "./repo-config.js";
export type { ComponentLibraryClient, RepoConfigClient } from "./repo-config.js";
export { createAppReviewClient } from "./app-github.js";
export type { AppReviewClient, AppReviewTarget } from "./app-github.js";
export { createInMemoryRunStore, createSqlRunStore } from "./run-store.js";
export type { RunStore, CompletedRunRecord } from "./run-store.js";
export { createSqlMeasurementBaselineStore } from "./measurement-baseline-store.js";
export { createSqlTenantDeleter, offboardTenant } from "./offboarding.js";
export type {
  DeletedRowCounts,
  TenantDeleter,
  OffboardingAuditEntry,
  OffboardingDeps,
} from "./offboarding.js";

// Check Run mapping is owned by @gate/delivery (#11); re-exported here for the
// App-path service that publishes it.
export { mapCheckRunConclusion, buildCheckRun } from "@gate/delivery";
export type { CheckRunConclusion, CheckRun, CheckRunContext } from "@gate/delivery";

export {
  registerScreenshotRoute,
  stableScreenshotUrl,
  capabilityScreenshotUrl,
  buildRunUrl,
  buildScreenshotRecords,
  deriveArtifactId,
  mintScreenshotCapability,
  verifyScreenshotCapability,
  createInMemoryScreenshotRegistry,
  createSqlScreenshotRegistry,
  createTemplateSignedUrlProvider,
} from "./screenshots.js";
export type {
  ScreenshotVisibility,
  ArtifactScope,
  ScreenshotRecord,
  ScreenshotRegistry,
  ScreenshotRegistryWriter,
  SignedUrlProvider,
  ScreenshotAuthorizer,
  ScreenshotRouteOptions,
  ScreenshotCapability,
  ScreenshotOwnership,
  DashboardRunUrlScope,
} from "./screenshots.js";
export { GITHUB_API_ROOT } from "./github-api.js";
