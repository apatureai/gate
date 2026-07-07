import { describe, expect, it, vi } from "vitest";
import {
  completedReviewId,
  createReviewQueue,
  type QueueLike,
  type ReviewJobPayload,
  reviewQueueKey,
} from "../src/queue.js";

const payload: ReviewJobPayload = {
  installationId: "inst_1",
  owner: "acme",
  name: "web",
  prNumber: 42,
  headSha: "abc123",
  baseSha: "def456",
  previewUrl: "https://preview.example.com",
  previewProvider: "vercel",
  previewSource: "deployment_status",
  depth: "deep",
  deploymentId: 1001,
};

describe("queue keys", () => {
  it("supersession key is repo#pr", () => {
    expect(reviewQueueKey("acme", "web", 42)).toBe("acme/web#42");
  });
  it("engine job idempotency helper is pr:head_sha, distinct from the durable runs identity", () => {
    expect(completedReviewId(42, "abc123")).toBe("42:abc123");
  });
});

describe("createReviewQueue", () => {
  it("enqueues under the repo#pr jobId, superseding any pending job first", async () => {
    const calls: string[] = [];
    const queue: QueueLike = {
      remove: vi.fn(async (id: string) => void calls.push(`remove:${id}`)),
      add: vi.fn(async (_name, _data, opts) => void calls.push(`add:${opts.jobId}`)),
    };
    const jobId = await createReviewQueue(queue).enqueue(payload);

    expect(jobId).toBe("acme/web#42");
    // remove-then-add: newest push wins.
    expect(calls).toEqual(["remove:acme/web#42", "add:acme/web#42"]);
    expect(queue.add).toHaveBeenCalledWith("review", payload, { jobId: "acme/web#42" });
  });

  it("payload carries IDs/refs only — no artifacts", () => {
    // No buffers/base64/large blobs; the serialized job is small.
    const serialized = JSON.stringify(payload);
    expect(serialized.length).toBeLessThan(512);
    expect(serialized).not.toContain("data:image");
    expect(Object.keys(payload).sort()).toEqual(
      [
        "baseSha",
        "deploymentId",
        "depth",
        "headSha",
        "installationId",
        "name",
        "owner",
        "prNumber",
        "previewProvider",
        "previewSource",
        "previewUrl",
      ].sort(),
    );
  });
});
