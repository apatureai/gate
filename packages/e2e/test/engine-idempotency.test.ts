import { DEFAULT_CONFIG } from "@gate/config";
import {
  assertReviewOutcomeIdentity,
  createJudgmentEngineClient,
  type EngineTransport,
  type JobStatus,
  type JobSubmission,
  type ReviewRequestContext,
  type SubmitResponse,
} from "@gate/engine";
import { loadGoldenReviewResult } from "@gate/types";
import { describe, expect, it } from "vitest";

const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";
const golden = loadGoldenReviewResult();

function context(repositoryName: string): ReviewRequestContext {
  return {
    installationId: "77",
    repository: { owner: "acme", name: repositoryName, defaultBranch: "main" },
    pullRequest: {
      number: 7,
      headSha: HEAD_SHA,
      baseSha: "89abcdef0123456789abcdef0123456789abcdef",
      title: "Shared template update",
      body: null,
    },
    preview: { url: `https://${repositoryName}.example.test`, provider: "explicit", environment: "Preview" },
    config: DEFAULT_CONFIG,
    publishMode: "advisory",
    depth: "deep",
  };
}

/**
 * Minimal producer-contract fake mirroring Judgment Engine's durable key:
 * `(consumer, installation, intent_type, caller_intent_hash)`. The caller hash
 * remains opaque; the fake only persists and deduplicates it.
 */
class ContractEngineTransport implements EngineTransport {
  readonly submissions: Array<{ status: 202 | 409; jobId: string; submission: JobSubmission }> = [];
  private readonly jobByIntent = new Map<string, string>();
  private readonly statusByJob = new Map<string, JobStatus>();

  async submit(submission: JobSubmission): Promise<SubmitResponse> {
    const key = `gate:${submission.request.installationId}:pr_review:${submission.idempotencyKey}`;
    const existing = this.jobByIntent.get(key);
    if (existing) {
      this.submissions.push({ status: 409, jobId: existing, submission });
      return { status: 409, jobId: existing };
    }

    const jobId = `job_${this.jobByIntent.size + 1}`;
    const repository = `${submission.request.repository.owner}/${submission.request.repository.name}`;
    this.jobByIntent.set(key, jobId);
    this.statusByJob.set(jobId, {
      jobId,
      state: "completed",
      result: { ...golden, overall: `review for ${repository}` },
    });
    this.submissions.push({ status: 202, jobId, submission });
    return { status: 202, jobId };
  }

  async poll(jobId: string): Promise<JobStatus> {
    const status = this.statusByJob.get(jobId);
    if (!status) throw new Error(`unknown job ${jobId}`);
    return status;
  }

  async cancel(): Promise<void> {}
}

describe("Gate ↔ Judgment Engine repository-scoped idempotency contract", () => {
  it("deduplicates exact retries without colliding repositories in one installation", async () => {
    const transport = new ContractEngineTransport();
    const client = createJudgmentEngineClient(transport);
    const repoA = context("a");
    const repoB = context("b");

    const firstA = await client.review(repoA);
    const firstB = await client.review(repoB);
    const retryA = await client.review(repoA);
    const retryB = await client.review(repoB);

    expect(transport.submissions.map(({ status }) => status)).toEqual([202, 202, 409, 409]);
    expect(transport.submissions[0]?.jobId).not.toBe(transport.submissions[1]?.jobId);
    expect(transport.submissions[2]?.jobId).toBe(transport.submissions[0]?.jobId);
    expect(transport.submissions[3]?.jobId).toBe(transport.submissions[1]?.jobId);
    expect(transport.submissions[0]?.submission.idempotencyKey).not.toBe(
      transport.submissions[1]?.submission.idempotencyKey,
    );
    expect(transport.submissions[2]?.submission.idempotencyKey).toBe(
      transport.submissions[0]?.submission.idempotencyKey,
    );

    expect(firstA.status).toBe("completed");
    expect(firstB.status).toBe("completed");
    expect(retryA.status).toBe("completed");
    expect(retryB.status).toBe("completed");
    expect(() => assertReviewOutcomeIdentity(firstA, repoA)).not.toThrow();
    expect(() => assertReviewOutcomeIdentity(firstB, repoB)).not.toThrow();
    expect(() => assertReviewOutcomeIdentity(firstA, repoB)).toThrow(/does not match/);
    expect(() => assertReviewOutcomeIdentity(firstB, repoA)).toThrow(/does not match/);
  });
});
