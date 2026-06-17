import { BULL_PREFIX, createRedisConnection } from "@gate/redis";
import { Queue } from "bullmq";
import { createReviewQueue, type QueueLike, REVIEW_QUEUE_NAME, type ReviewQueue } from "./queue.js";

/**
 * BullMQ-backed review queue. Uses a resilient Redis connection
 * (maxRetriesPerRequest: null, required by BullMQ) under the `bull:` prefix.
 * The orchestration sits behind the ReviewQueue interface so BullMQ can be
 * swapped for Inngest later (#48) without rewriting callers.
 */
export function createBullReviewQueue(redisUrl: string): { queue: Queue; reviewQueue: ReviewQueue } {
  const connection = createRedisConnection(redisUrl);
  const queue = new Queue(REVIEW_QUEUE_NAME, { connection, prefix: BULL_PREFIX });
  // BullMQ's Queue satisfies QueueLike structurally (remove + add); its generics
  // just don't line up nominally.
  const reviewQueue = createReviewQueue(queue as unknown as QueueLike);
  return { queue, reviewQueue };
}
