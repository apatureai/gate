import { BULL_PREFIX, createRedisConnection } from "@gate/redis";
import { Queue, Worker } from "bullmq";
import {
  createReviewQueue,
  type QueueLike,
  REVIEW_QUEUE_NAME,
  type ReviewJobPayload,
  reviewQueueKey,
} from "./queue.js";

/**
 * Queue abstraction (TRD §5, §12, §15.3; ARCHITECTURE §8 D2). Orchestration
 * (supersession, the publish-time SHA guard) depends only on this interface, so
 * BullMQ can be swapped for a durable-execution engine (Inngest) without a
 * rewrite — see docs/queue-migration-inngest.md. BullMQ cannot preempt active
 * jobs, so cancellation is cooperative via an AbortSignal threaded into the
 * engine client; the publish-time SHA guard is the queue-agnostic backstop.
 */
export interface JobContext {
  jobId: string;
  /** Aborted on supersession/cancel; thread this into the engine HTTP client. */
  signal: AbortSignal;
}

export type ReviewJobHandler = (job: ReviewJobPayload, ctx: JobContext) => Promise<void>;

export interface ReviewJobWorker {
  enqueue(job: ReviewJobPayload): Promise<string>;
  cancel(key: string): Promise<void>;
  onJob(handler: ReviewJobHandler): void;
}

/**
 * Tracks one AbortController per supersession key for cooperative cancellation.
 * Creating a controller for a key aborts any prior one (newest wins).
 */
export class CancellationRegistry {
  private readonly controllers = new Map<string, AbortController>();

  create(key: string): AbortController {
    this.controllers.get(key)?.abort();
    const controller = new AbortController();
    this.controllers.set(key, controller);
    return controller;
  }

  abort(key: string): boolean {
    const controller = this.controllers.get(key);
    if (!controller) return false;
    controller.abort();
    this.controllers.delete(key);
    return true;
  }

  /** Clear a key once its job finished (only if it's still the active one). */
  done(key: string, controller: AbortController): void {
    if (this.controllers.get(key) === controller) this.controllers.delete(key);
  }

  has(key: string): boolean {
    return this.controllers.has(key);
  }
}

/**
 * In-process ReviewJobWorker reference implementation (local dev + tests): real
 * supersession and cooperative cancellation, no Redis. Proves the interface
 * semantics the BullMQ adapter must also honor.
 */
export function createInMemoryReviewWorker(): ReviewJobWorker {
  const registry = new CancellationRegistry();
  const queue: ReviewJobPayload[] = [];
  let handler: ReviewJobHandler | undefined;
  let running = false;

  const keyOf = (job: ReviewJobPayload): string => reviewQueueKey(job.owner, job.name, job.prNumber);
  const dropPending = (key: string): void => {
    for (let i = queue.length - 1; i >= 0; i--) {
      if (keyOf(queue[i]!) === key) queue.splice(i, 1);
    }
  };

  const pump = async (): Promise<void> => {
    if (running || !handler) return;
    running = true;
    try {
      while (queue.length > 0) {
        const job = queue.shift()!;
        const key = keyOf(job);
        const controller = registry.create(key);
        try {
          await handler(job, { jobId: key, signal: controller.signal });
        } finally {
          registry.done(key, controller);
        }
      }
    } finally {
      running = false;
    }
  };

  return {
    async enqueue(job) {
      const key = keyOf(job);
      dropPending(key); // newest push supersedes a pending one
      registry.abort(key); // and cooperatively cancels an in-flight older one
      queue.push(job);
      void pump();
      return key;
    },
    async cancel(key) {
      dropPending(key);
      registry.abort(key);
    },
    onJob(h) {
      handler = h;
      void pump();
    },
  };
}

/**
 * BullMQ adapter. enqueue uses repo#pr supersession; cancel removes a pending
 * job and aborts an in-flight one's signal (cooperative — BullMQ can't preempt).
 */
export function createBullReviewWorker(redisUrl: string): ReviewJobWorker {
  const queue = new Queue(REVIEW_QUEUE_NAME, { connection: createRedisConnection(redisUrl), prefix: BULL_PREFIX });
  const reviewQueue = createReviewQueue(queue as unknown as QueueLike);
  const registry = new CancellationRegistry();
  let worker: Worker | undefined;

  return {
    enqueue: (job) => reviewQueue.enqueue(job),
    async cancel(key) {
      await queue.remove(key).catch(() => undefined);
      registry.abort(key);
    },
    onJob(handler) {
      worker = new Worker(
        REVIEW_QUEUE_NAME,
        async (job) => {
          const data = job.data as ReviewJobPayload;
          const key = job.id ?? reviewQueueKey(data.owner, data.name, data.prNumber);
          const controller = registry.create(key);
          try {
            await handler(data, { jobId: key, signal: controller.signal });
          } finally {
            registry.done(key, controller);
          }
        },
        { connection: createRedisConnection(redisUrl), prefix: BULL_PREFIX },
      );
      void worker;
    },
  };
}
