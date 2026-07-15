import type { ReviewDepth } from "@gate/types";

/**
 * Review queue model (TRD §2, §3.2, §5). The supersession/dedup key is
 * `repo#pr` (at most one pending review per PR; newest push wins). Payloads
 * carry IDs/refs only — screenshots, critique JSON, and annotations flow
 * through engine-owned object storage, never the queue. The durable completed
 * review identity lives in `runs` as `(repo_owner, repo_name, pr_number,
 * head_sha)`.
 */
export const REVIEW_QUEUE_NAME = "review";

export interface ReviewJobPayload {
  installationId: string;
  owner: string;
  name: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  previewUrl: string;
  previewProvider: string;
  previewSource: string;
  depth: ReviewDepth;
  /** deployment_status id on the App path, for traceability. */
  deploymentId?: number;
}

/** Supersession/dedup key for the queue: `owner/name#pr`. */
export function reviewQueueKey(owner: string, name: string, prNumber: number): string {
  return `${owner}/${name}#${prNumber}`;
}

/** Minimal queue surface (satisfied by a BullMQ Queue). */
export interface QueueLike {
  remove(jobId: string): Promise<unknown>;
  add(name: string, data: ReviewJobPayload, opts: { jobId: string }): Promise<unknown>;
}

export interface ReviewQueue {
  /** Enqueue a review, superseding any pending job for the same PR. Returns the jobId. */
  enqueue(payload: ReviewJobPayload): Promise<string>;
}

/**
 * Wrap a queue so enqueue is keyed by `repo#pr` and the newest push supersedes a
 * pending older job for that PR (remove-then-add). Active jobs can't be
 * preempted by BullMQ; cooperative cancellation (#4) + the publish-time SHA
 * guard are the backstops.
 */
export function createReviewQueue(queue: QueueLike): ReviewQueue {
  return {
    async enqueue(payload) {
      const jobId = reviewQueueKey(payload.owner, payload.name, payload.prNumber);
      await queue.remove(jobId);
      await queue.add(REVIEW_QUEUE_NAME, payload, { jobId });
      return jobId;
    },
  };
}
