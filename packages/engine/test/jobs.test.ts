import { loadGoldenReviewResult } from "@gate/types";
import { describe, expect, it, vi } from "vitest";
import {
  cancelEngineJob,
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

const submission: JobSubmission = {
  idempotencyKey: idempotencyKey(42, "abc123"),
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
  it("is pr:headSha", () => {
    expect(idempotencyKey(7, "deadbeef")).toBe("7:deadbeef");
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
    const t = transport({
      poll: async () => {
        polls += 1;
        return { jobId: "job_1", state: "running" };
      },
    });
    const clock = virtualClock();
    const outcome = await runEngineJob(t, submission, { depth: "deep", ...clock });
    expect(outcome).toEqual({ status: "timed_out", reason: "review_timed_out", jobId: "job_1" });
    // Bounded by the 10-min deadline with 30s+ deep backoff — far fewer than, say, 100 polls.
    expect(polls).toBeLessThan(20);
    expect(clock.now()).toBeGreaterThanOrEqual(REVIEW_DEADLINE_MS - 60_000);
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
