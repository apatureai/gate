import type { GateReviewRequest } from "@gate/types";

export { runAction } from "./run.js";
export type {
  ActionRunContext,
  ActionRunInputs,
  ActionRunDeps,
  ActionStatus,
  ActionOutcome,
} from "./run.js";
export { createGitHubApi } from "./github.js";
export type { GitHubTarget, GitHubApi } from "./github.js";
export {
  resolvePreviewUrl,
} from "./preview.js";
export type {
  DiscoverySource,
  PreviewResolution,
  PreviewDiscoveryOutcome,
  PreviewDiscoveryInput,
  ProviderComment,
} from "./preview.js";
export { parsePreviewBuildFacts } from "./build-facts.js";
export { startLocalServer, buildAllowlistedEnv } from "./local-serve.js";
export type {
  LocalServerReason,
  LocalServerHandle,
  LocalServerStartResult,
  StartLocalServerOptions,
} from "./local-serve.js";
export { buildResourceCappedCommand, DEFAULT_RESOURCE_LIMITS, resolveCapShell } from "./resource-cap.js";
export type { ResourceLimits } from "./resource-cap.js";
export {
  censusProcessGroup,
  compressCensus,
  DEMO_RUNNER_SECRETS,
  formatSupervisorDemoReport,
  isGroupAlive,
  liveProcesses,
  parseProcessTable,
  parseProcStat,
  runSupervisorDemo,
} from "./supervisor-demo.js";
export { formatReviewDemoResult, renderFixturePage, runReviewDemo } from "./review-demo.js";
export type { ReviewDemoResult, ReviewDemoScreenshot } from "./review-demo.js";
export {
  formatLiveReviewResult,
  fixturePreviewCommand,
  LiveReviewConfigError,
  LiveReviewEndpointError,
  runLiveReview,
} from "./live-review.js";
export type { LiveReviewOptions, LiveReviewResult } from "./live-review.js";
export type {
  CensusSample,
  ChildLimits,
  ProcessInfo,
  RedirectScenario,
  SupervisorDemoOptions,
  SupervisorDemoReport,
  TeardownScenario,
} from "./supervisor-demo.js";
export { setupFailureCheckRun, publishSetupFailureCheckRun } from "./setup-failure.js";
export type { SetupFailurePublisher } from "./setup-failure.js";

/**
 * Minimal GitHub token permissions the Action path requires.
 *
 * Hard invariant (TRD §8, ARCHITECTURE §8): Gate is judgment-only and must
 * NEVER request `contents: write` or push code. `contents` is read-only so Gate
 * can read config and diffs; it publishes via Check Runs and PR comments only.
 * The full minimal-permissions audit is #21; this constant is the seed and is
 * enforced by tests here.
 */
export const GATE_GITHUB_PERMISSIONS = {
  contents: "read",
  "pull-requests": "write",
  checks: "write",
  statuses: "read",
} as const;

export type ActionInputs = {
  installationId: string;
  owner: string;
  repoName: string;
  defaultBranch: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  prTitle: string;
  prBody: string | null;
  previewUrl: string;
  previewProvider: GateReviewRequest["preview"]["provider"];
  previewEnvironment: string | null;
  config: GateReviewRequest["config"];
  publishMode: GateReviewRequest["publishMode"];
  depth: GateReviewRequest["depth"];
};

/**
 * Assemble a `GateReviewRequest` from resolved Action inputs. Preview discovery
 * (#8) and config normalization (#27) produce these inputs; this function only
 * shapes them into the engine boundary contract.
 */
export function buildReviewRequest(inputs: ActionInputs): GateReviewRequest {
  return {
    installationId: inputs.installationId,
    repository: {
      owner: inputs.owner,
      name: inputs.repoName,
      defaultBranch: inputs.defaultBranch,
    },
    pullRequest: {
      number: inputs.prNumber,
      headSha: inputs.headSha,
      baseSha: inputs.baseSha,
      title: inputs.prTitle,
      body: inputs.prBody,
    },
    preview: {
      url: inputs.previewUrl,
      provider: inputs.previewProvider,
      environment: inputs.previewEnvironment,
    },
    config: inputs.config,
    publishMode: inputs.publishMode,
    depth: inputs.depth,
  };
}
