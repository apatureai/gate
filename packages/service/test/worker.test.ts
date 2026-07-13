import { describe, expect, it } from "vitest";
import { CancellationRegistry, createInMemoryReviewWorker } from "../src/worker.js";
import type { ReviewJobPayload } from "../src/queue.js";

function payload(prNumber: number, headSha: string): ReviewJobPayload {
  return {
    installationId: "inst_1",
    owner: "acme",
    name: "web",
    prNumber,
    headSha,
    baseSha: "base",
    previewUrl: "https://preview.example.com",
    previewProvider: "vercel",
    previewSource: "deployment_status",
    depth: "deep",
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("CancellationRegistry", () => {
  it("creating a key aborts the prior controller (newest wins)", () => {
    const reg = new CancellationRegistry();
    const first = reg.create("acme/web#1");
    const second = reg.create("acme/web#1");
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
  });

  it("abort signals and clears; done only clears the matching controller", () => {
    const reg = new CancellationRegistry();
    const c = reg.create("k");
    expect(reg.abort("k")).toBe(true);
    expect(c.signal.aborted).toBe(true);
    expect(reg.has("k")).toBe(false);
    expect(reg.abort("missing")).toBe(false);
  });

  it("abortAll signals and clears every active controller", () => {
    const reg = new CancellationRegistry();
    const first = reg.create("one");
    const second = reg.create("two");
    expect(reg.abortAll()).toBe(2);
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
    expect(reg.has("one")).toBe(false);
    expect(reg.has("two")).toBe(false);
  });
});

describe("createInMemoryReviewWorker", () => {
  it("runs the handler with a job and an abort signal", async () => {
    const worker = createInMemoryReviewWorker();
    const seen: Array<{ pr: number; aborted: boolean }> = [];
    worker.onJob(async (job, ctx) => {
      seen.push({ pr: job.prNumber, aborted: ctx.signal.aborted });
    });
    await worker.enqueue(payload(42, "sha1"));
    await tick();
    expect(seen).toEqual([{ pr: 42, aborted: false }]);
  });

  it("cancel aborts the in-flight job's signal", async () => {
    const worker = createInMemoryReviewWorker();
    let observedAbort = false;
    let release!: () => void;
    const started = new Promise<void>((r) => (release = r));
    worker.onJob(async (_job, ctx) => {
      release();
      await new Promise<void>((resolve) => {
        ctx.signal.addEventListener("abort", () => {
          observedAbort = true;
          resolve();
        });
      });
    });
    await worker.enqueue(payload(42, "sha1"));
    await started;
    await worker.cancel("acme/web#42");
    await tick();
    expect(observedAbort).toBe(true);
  });

  it("isolates a throwing job so the queue keeps draining", async () => {
    const worker = createInMemoryReviewWorker();
    const processed: number[] = [];
    worker.onJob(async (job) => {
      if (job.prNumber === 1) throw new Error("boom");
      processed.push(job.prNumber);
    });
    await worker.enqueue(payload(1, "s1"));
    await worker.enqueue(payload(2, "s2"));
    await tick();
    await tick();
    expect(processed).toEqual([2]); // job 1 failed but job 2 still ran
  });

  it("supersedes a pending job for the same PR before the handler is attached", async () => {
    const worker = createInMemoryReviewWorker();
    const processed: string[] = [];
    await worker.enqueue(payload(42, "old"));
    await worker.enqueue(payload(42, "new")); // supersedes the pending old one
    worker.onJob(async (job) => {
      processed.push(job.headSha);
    });
    await tick();
    expect(processed).toEqual(["new"]);
  });

  it("close aborts active work and rejects new jobs", async () => {
    const worker = createInMemoryReviewWorker();
    let observedAbort = false;
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    worker.onJob(async (_job, ctx) => {
      started();
      await new Promise<void>((resolve) => {
        ctx.signal.addEventListener("abort", () => {
          observedAbort = true;
          resolve();
        });
      });
    });
    await worker.enqueue(payload(42, "sha1"));
    await running;

    await worker.close?.();

    await tick();
    expect(observedAbort).toBe(true);
    await expect(worker.enqueue(payload(42, "sha2"))).rejects.toThrow("worker is closed");
  });
});
