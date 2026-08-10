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
 * rewrite; see "Deferred by design" in README.md. BullMQ cannot preempt active
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
  /** Stop accepting work, abort active jobs, and release queue resources. */
  close?(): Promise<void>;
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

  /** Abort every active job during process shutdown. */
  abortAll(): number {
    const active = this.controllers.size;
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
    return active;
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
  let closed = false;

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
        } catch {
          // Isolate a failed job (like BullMQ) so it doesn't stall the queue or
          // surface as an unhandled rejection; the handler owns its error policy.
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
      if (closed) throw new Error("review worker is closed");
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
      if (closed) throw new Error("review worker is closed");
      handler = h;
      void pump();
    },
    async close() {
      closed = true;
      queue.length = 0;
      registry.abortAll();
    },
  };
}

/**
 * BullMQ adapter. enqueue uses repo#pr supersession; cancel removes a pending
 * job and aborts an in-flight one's signal (cooperative, since BullMQ can't preempt).
 */
export function createBullReviewWorker(redisUrl: string): ReviewJobWorker {
  // BullMQ treats injected ioredis clients as shared and therefore does not quit
  // them from Queue/Worker.close(). Retain both clients so this owner can close
  // every socket after BullMQ has drained its own resources.
  const queueConnection = createRedisConnection(redisUrl);
  const queue = new Queue(REVIEW_QUEUE_NAME, { connection: queueConnection, prefix: BULL_PREFIX });
  const reviewQueue = createReviewQueue(queue as unknown as QueueLike);
  const registry = new CancellationRegistry();
  let worker: Worker | undefined;
  let workerConnection: ReturnType<typeof createRedisConnection> | undefined;
  let closePromise: Promise<void> | undefined;
  let closed = false;

  return {
    enqueue(job) {
      if (closed) return Promise.reject(new Error("review worker is closed"));
      return reviewQueue.enqueue(job);
    },
    async cancel(key) {
      await queue.remove(key).catch(() => undefined);
      registry.abort(key);
    },
    onJob(handler) {
      if (closed) throw new Error("review worker is closed");
      workerConnection = createRedisConnection(redisUrl);
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
        { connection: workerConnection, prefix: BULL_PREFIX },
      );
    },
    close() {
      closePromise ??= (async () => {
        closed = true;
        registry.abortAll();
        const errors: unknown[] = [];
        const close = async (fn: (() => Promise<unknown>) | undefined): Promise<void> => {
          if (!fn) return;
          try {
            await fn();
          } catch (error) {
            errors.push(error);
          }
        };
        const activeWorker = worker;
        const activeWorkerConnection = workerConnection;
        await close(activeWorker ? () => activeWorker.close() : undefined);
        await close(() => queue.close());
        await close(activeWorkerConnection ? () => activeWorkerConnection.quit() : undefined);
        await close(() => queueConnection.quit());
        if (errors.length > 0) throw new AggregateError(errors, "review worker shutdown failed");
      })();
      return closePromise;
    },
  };
}
