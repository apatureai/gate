import { DEFAULT_CONFIG } from "@gate/config";
import { loadGoldenReviewResult } from "@gate/types";
import { describe, expect, it, vi } from "vitest";
import {
  assertReviewOutcomeIdentity,
  buildGateReviewRequest,
  createJudgmentEngineClient,
  type EngineTransport,
  extractReviewMetadata,
  type JobSubmission,
  type ReviewRequestContext,
} from "../src/index.js";

const goldenResult = loadGoldenReviewResult();
const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";

const ctx: ReviewRequestContext = {
  installationId: "inst_1",
  repository: { owner: "acme", name: "web", defaultBranch: "main" },
  pullRequest: { number: 42, headSha: HEAD_SHA, baseSha: "def456", title: "Redesign", body: null },
  preview: { url: "https://preview.example.com", provider: "vercel", environment: "Preview" },
  config: DEFAULT_CONFIG,
  publishMode: "advisory",
  depth: "deep",
};

const clock = () => {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
};

describe("buildGateReviewRequest", () => {
  it("assembles the engine contract from preview + config + PR context", () => {
    const req = buildGateReviewRequest(ctx);
    expect(req.repository).toEqual({ owner: "acme", name: "web", defaultBranch: "main" });
    expect(req.pullRequest.headSha).toBe(HEAD_SHA);
    expect(req.preview.provider).toBe("vercel");
    expect(req.depth).toBe("deep");
    expect(req.config).toBe(DEFAULT_CONFIG);
  });
});

describe("extractReviewMetadata", () => {
  it("surfaces engine/result provenance without hard-coding the model", () => {
    const meta = extractReviewMetadata(goldenResult);
    expect(meta.engineVersion).toBe(goldenResult.metadata.engineVersion);
    expect(meta.model).toBe(goldenResult.metadata.model); // whatever the engine selected
    expect(meta.uiDnaVersion).toBe(goldenResult.metadata.uiDnaVersion);
    // The client must not assume Claude.
    expect(meta.model.toLowerCase()).not.toContain("claude");
  });
});

describe("createJudgmentEngineClient.review", () => {
  it("submits a job keyed by (repo, pr, head_sha) and polls to completion", async () => {
    const submissions: JobSubmission[] = [];
    const transport: EngineTransport = {
      submit: async (s) => {
        submissions.push(s);
        return { status: 202, jobId: "job_1" };
      },
      poll: async () => ({ jobId: "job_1", state: "completed", result: goldenResult }),
      cancel: async () => {},
    };
    const client = createJudgmentEngineClient(transport, { ...clock() });
    const outcome = await client.review(ctx);

    expect(submissions[0]?.idempotencyKey).toMatch(/^gate-review-v2:sha256:[0-9a-f]{64}$/);
    expect(submissions[0]?.depth).toBe("deep");
    expect(outcome).toMatchObject({ status: "completed" });
    if (outcome.status === "completed") {
      expect(extractReviewMetadata(outcome.result).model).toBe(goldenResult.metadata.model);
    }
    expect(outcome.reviewIdentity).toEqual({
      repositoryOwner: "acme",
      repositoryName: "web",
      prNumber: 42,
      headSha: HEAD_SHA,
    });
    expect(() => assertReviewOutcomeIdentity(outcome, ctx)).not.toThrow();
    expect(() =>
      assertReviewOutcomeIdentity(outcome, {
        ...ctx,
        repository: { ...ctx.repository, name: "other" },
      }),
    ).toThrow(/does not match/);
  });

  it("retries a transient submit failure with backoff (bounded)", async () => {
    const submit = vi
      .fn()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValue({ status: 202, jobId: "job_1" });
    const transport: EngineTransport = {
      submit,
      poll: async () => ({ jobId: "job_1", state: "completed", result: goldenResult }),
      cancel: async () => {},
    };
    const client = createJudgmentEngineClient(transport, { submitRetries: 2, ...clock() });
    const outcome = await client.review(ctx);
    expect(submit).toHaveBeenCalledTimes(2);
    expect(outcome).toMatchObject({ status: "completed" });
  });

  it("gives up after exhausting submit retries", async () => {
    const submit = vi.fn().mockRejectedValue(new Error("down"));
    const transport: EngineTransport = {
      submit,
      poll: async () => ({ jobId: "x", state: "running" }),
      cancel: async () => {},
    };
    const client = createJudgmentEngineClient(transport, { submitRetries: 1, ...clock() });
    await expect(client.review(ctx)).rejects.toThrow("down");
    expect(submit).toHaveBeenCalledTimes(2); // initial + 1 retry
  });

  it("delegates cancellation to the transport", async () => {
    const cancel = vi.fn(async () => {});
    const client = createJudgmentEngineClient({
      submit: async () => ({ status: 202, jobId: "j" }),
      poll: async () => ({ jobId: "j", state: "running" }),
      cancel,
    });
    await client.cancel("job_9", "inst_9");
    expect(cancel).toHaveBeenCalledWith("job_9", "inst_9");
  });

  it("polls with the review installationId instead of relying on transport-local state", async () => {
    const poll = vi.fn(async () => ({ jobId: "job_1", state: "completed" as const, result: goldenResult }));
    const client = createJudgmentEngineClient(
      {
        submit: async () => ({ status: 202, jobId: "job_1" }),
        poll,
        cancel: async () => {},
      },
      { ...clock() },
    );
    await client.review(ctx);
    expect(poll).toHaveBeenCalledWith("job_1", "inst_1", undefined);
  });
});
