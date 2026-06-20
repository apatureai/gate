import type { GateReviewRequest } from "@gate/types";
import type { HostedReviewContext } from "./hosted-review.js";
import type { ReviewJobPayload } from "./queue.js";

/**
 * PR-metadata hydration for the App path. The queue payload is IDs/refs only
 * (#3), so before `runHostedReview` the worker fetches the PR's title/body/
 * fork-flag/default-branch (via the installation token, #2) and combines them
 * with the payload into a HostedReviewContext.
 */
export interface PullRequestDetails {
  defaultBranch: string;
  title: string;
  body: string | null;
  isFork: boolean;
}

export interface PullRequestFetcher {
  fetchPullRequest(owner: string, name: string, prNumber: number): Promise<PullRequestDetails | null>;
}

/** Combine an IDs-only queue payload with fetched PR details into a review context. */
export function hydrateReviewContext(
  payload: ReviewJobPayload,
  details: PullRequestDetails,
): HostedReviewContext {
  return {
    installationId: payload.installationId,
    repository: { owner: payload.owner, name: payload.name, defaultBranch: details.defaultBranch },
    pullRequest: {
      number: payload.prNumber,
      headSha: payload.headSha,
      baseSha: payload.baseSha,
      title: details.title,
      body: details.body,
    },
    isFork: details.isFork,
    preview: {
      url: payload.previewUrl,
      provider: payload.previewProvider as GateReviewRequest["preview"]["provider"],
      source: payload.previewSource,
    },
  };
}
