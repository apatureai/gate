import { loadGoldenReviewResult } from "@gate/types";
import { describe, expect, it, vi } from "vitest";
import {
  cancelEngineJob,
  canonicalReviewIdentity,
  EngineAbortedError,
  type EngineTransport,
  idempotencyKey,
  type JobStatus,
  type JobSubmission,
  nextPollDelayMs,
  parseRetryAfterMs,
  REVIEW_DEADLINE_MS,
  runEngineJob,
  type SubmitResponse,
} from "../src/index.js";

const goldenResult = loadGoldenReviewResult();
const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";
const identity = {
  repository: { owner: "Acme", name: "Web" },
  pullRequest: { number: 42, headSha: HEAD_SHA },
};

const submission: JobSubmission = {
  idempotencyKey: idempotencyKey(identity),
  depth: "deep",
  request: { installationId: "inst_1" } as never, // full request shape is exercised by #37
};

/** Virtual clock so backoff/deadline logic is deterministic. */
function virtualClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

function transport(overrides: Partial<EngineTransport>): EngineTransport {
  return {
    submit: async (): Promise<SubmitResponse> => ({ status: 202, jobId: "job_1" }),
    poll: async (): Promise<JobStatus> => ({ jobId: "job_1", state: "running" }),
    cancel: async () => {},
    ...overrides,
  };
}

describe("idempotencyKey + backoff", () => {
  it("hashes a canonical repository-scoped tuple under the v2 namespace", () => {
    const key = idempotencyKey(identity);
    expect(key).toBe(
      "gate-review-v2:sha256:a14a2a84926a21784de26c45b71089c23bdfd8d0a17a282a2aa55135a501a2b9",
    );
    expect(key).not.toContain(HEAD_SHA);
    expect(canonicalReviewIdentity(identity)).toEqual({
      repositoryOwner: "acme",
      repositoryName: "web",
      prNumber: 42,
      headSha: HEAD_SHA,
    });
  });

  it("is stable across GitHub name/SHA casing and distinct across repositories", () => {
    expect(
      idempotencyKey({
        repository: { owner: "acme", name: "web" },
        pullRequest: { number: 42, headSha: HEAD_SHA.toUpperCase() },
      }),
    ).toBe(idempotencyKey(identity));
    expect(
      idempotencyKey({
        repository: { owner: "acme", name: "other" },
        pullRequest: { number: 42, headSha: HEAD_SHA },
      }),
    ).not.toBe(idempotencyKey(identity));
    expect(
      idempotencyKey({
        repository: { owner: "ab", name: "c" },
        pullRequest: { number: 42, headSha: HEAD_SHA },
      }),
    ).not.toBe(
      idempotencyKey({
        repository: { owner: "a", name: "bc" },
        pullRequest: { number: 42, headSha: HEAD_SHA },
      }),
    );
  });

  it("fails closed on a partial SHA or ambiguous repository name", () => {
    expect(() =>
      idempotencyKey({
        repository: { owner: "acme", name: "web" },
        pullRequest: { number: 42, headSha: "deadbeef" },
      }),
    ).toThrow(/full 40-character/);
    expect(() =>
      idempotencyKey({
        repository: { owner: "acme/other", name: "web" },
        pullRequest: { number: 42, headSha: HEAD_SHA },
      }),
    ).toThrow(/repository owner/);
  });

  it("is depth-aware: triage 10s+, deep 30s+, then +10s", () => {
    expect(nextPollDelayMs("triage", 0)).toBe(10_000);
    expect(nextPollDelayMs("triage", 1)).toBe(20_000);
    expect(nextPollDelayMs("deep", 0)).toBe(30_000);
    expect(nextPollDelayMs("deep", 2)).toBe(50_000);
  });

  it("parses Retry-After (seconds and HTTP-date)", () => {
    expect(parseRetryAfterMs("5")).toBe(5000);
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs("garbage")).toBeNull();
    const future = new Date(Date.now() + 10_000).toUTCString();
    const ms = parseRetryAfterMs(future);
    expect(ms).not.toBeNull();
    expect(ms!).toBeGreaterThan(5000);
  });
});

describe("runEngineJob", () => {
  it("submits then polls to completion and returns the result", async () => {
    let polls = 0;
    const t = transport({
      poll: async () => {
        polls += 1;
        return polls < 3
          ? { jobId: "job_1", state: "running" }
          : { jobId: "job_1", state: "completed", result: goldenResult };
      },
    });
    const clock = virtualClock();
    const outcome = await runEngineJob(t, submission, { depth: "deep", ...clock });
    expect(outcome).toMatchObject({ status: "completed", jobId: "job_1" });
    if (outcome.status === "completed") expect(outcome.result.grade).toBe(goldenResult.grade);
  });

  it("polls the existing job on a 409 instead of re-running capture", async () => {
    const submit = vi.fn(async (): Promise<SubmitResponse> => ({ status: 409, jobId: "existing" }));
    const t = transport({
      submit,
      poll: async () => ({ jobId: "existing", state: "completed", result: goldenResult }),
    });
    const clock = virtualClock();
    const outcome = await runEngineJob(t, submission, { depth: "triage", ...clock });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ status: "completed", jobId: "existing" });
  });

  it("does not submit when already superseded", async () => {
    const controller = new AbortController();
    controller.abort();
    const submit = vi.fn(async (): Promise<SubmitResponse> => ({ status: 202, jobId: "job_1" }));
    const t = transport({ submit });

    await expect(
      runEngineJob(t, submission, { depth: "deep", signal: controller.signal, ...virtualClock() }),
    ).rejects.toMatchObject({
      name: "EngineAbortedError",
      jobId: `submit:${submission.idempotencyKey}`,
    });
    expect(submit).not.toHaveBeenCalled();
  });

  it("passes the supersession signal to submit and maps an in-flight submit abort", async () => {
    const controller = new AbortController();
    let submitSignal: AbortSignal | undefined;
    const submit = vi.fn(async (_submission: JobSubmission, signal?: AbortSignal): Promise<SubmitResponse> => {
      submitSignal = signal;
      controller.abort();
      throw new Error("aborted by fetch");
    });
    const poll = vi.fn(async (): Promise<JobStatus> => ({ jobId: "job_1", state: "running" }));
    const t = transport({ submit, poll });

    await expect(
      runEngineJob(t, submission, { depth: "triage", signal: controller.signal, ...virtualClock() }),
    ).rejects.toBeInstanceOf(EngineAbortedError);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submitSignal).toBe(controller.signal);
    expect(poll).not.toHaveBeenCalled();
  });

  it("times out at the deadline with review_timed_out and stops (no retry)", async () => {
    let polls = 0;
    const cancel = vi.fn(async () => {});
    const t = transport({
      poll: async () => {
        polls += 1;
        return { jobId: "job_1", state: "running" };
      },
      cancel,
    });
    const clock = virtualClock();
    const outcome = await runEngineJob(t, submission, { depth: "deep", ...clock });
    expect(outcome).toEqual({ status: "timed_out", reason: "review_timed_out", jobId: "job_1" });
    // Bounded by the 10-min deadline with 30s+ deep backoff — far fewer than, say, 100 polls.
    expect(polls).toBeLessThan(20);
    expect(clock.now()).toBeGreaterThanOrEqual(REVIEW_DEADLINE_MS - 60_000);
    expect(cancel).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledWith("job_1", "inst_1");
  });

  it.each([202, 409] as const)(
    "best-effort cancels a timed-out %i job without changing the neutral outcome",
    async (status) => {
      const cancel = vi.fn(async () => {
        throw new Error("engine unavailable");
      });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const t = transport({
        submit: async () => ({ status, jobId: "job_timeout" }),
        poll: async () => ({ jobId: "job_timeout", state: "running" }),
        cancel,
      });

      const outcome = await runEngineJob(t, submission, {
        depth: "triage",
        deadlineMs: 0,
        ...virtualClock(),
      });

      expect(outcome).toEqual({
        status: "timed_out",
        reason: "review_timed_out",
        jobId: "job_timeout",
      });
      expect(cancel).toHaveBeenCalledOnce();
      expect(cancel).toHaveBeenCalledWith("job_timeout", "inst_1");
      expect(warn).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith("[gate] timed-out engine job cancellation failed");
      warn.mockRestore();
    },
  );

  it("does not cancel completed or failed jobs", async () => {
    const cancel = vi.fn(async () => {});
    const completed = await runEngineJob(
      transport({
        poll: async () => ({ jobId: "job_1", state: "completed", result: goldenResult }),
        cancel,
      }),
      submission,
      { depth: "triage", deadlineMs: 0, ...virtualClock() },
    );
    const failed = await runEngineJob(
      transport({
        poll: async () => ({ jobId: "job_1", state: "failed", error: "capture failed" }),
        cancel,
      }),
      submission,
      { depth: "triage", deadlineMs: 0, ...virtualClock() },
    );

    expect(completed.status).toBe("completed");
    expect(failed.status).toBe("failed");
    expect(cancel).not.toHaveBeenCalled();
  });

  it("surfaces engine failure", async () => {
    const t = transport({ poll: async () => ({ jobId: "job_1", state: "failed", error: "capture crashed" }) });
    const outcome = await runEngineJob(t, submission, { depth: "triage", ...virtualClock() });
    expect(outcome).toMatchObject({ status: "failed", error: "capture crashed" });
  });
});

describe("cancelEngineJob", () => {
  it("is best-effort and swallows transport errors", async () => {
    const cancel = vi.fn(async () => {
      throw new Error("network");
    });
    await expect(cancelEngineJob(transport({ cancel }), "job_1", "inst_1")).resolves.toBeUndefined();
    expect(cancel).toHaveBeenCalledWith("job_1", "inst_1");
  });
});
