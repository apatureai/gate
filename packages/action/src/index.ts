import type { GateReviewRequest } from "@gate/types";

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
