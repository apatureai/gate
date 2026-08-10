import { EngineAbortedError, pollUntilDone, type EngineTransport } from "@gate/engine";
import { describe, expect, it } from "vitest";
import {
  createInMemorySupersessionStore,
  currentShaKey,
  guardPublish,
  isCurrentSha,
  recordEnqueue,
} from "../src/supersession.js";

const repo = { owner: "acme", name: "web", prNumber: 42 };

describe("current_sha tracking + publish-time guard", () => {
  it("sets current_sha on enqueue under the sha: key", async () => {
    const store = createInMemorySupersessionStore();
    const key = await recordEnqueue(store, repo, "sha1");
    expect(key).toBe(currentShaKey(repo));
    expect(key).toBe("sha:acme/web#42");
    expect(await store.getCurrentSha(key)).toBe("sha1");
  });

  it("two jobs for the same repo#pr: only the newest passes the publish guard", async () => {
    const store = createInMemorySupersessionStore();
    const key = await recordEnqueue(store, repo, "sha1"); // job 1 enqueued
    await recordEnqueue(store, repo, "sha2"); // job 2 (newer push) supersedes

    expect(await guardPublish(store, key, "sha1")).toBe(false); // stale job discarded
    expect(await guardPublish(store, key, "sha2")).toBe(true); // newest publishes
  });

  it("publish-time guard discards a stale SHA even if the abort signal was bypassed", async () => {
    const store = createInMemorySupersessionStore();
    const key = await recordEnqueue(store, repo, "current");
    // No signal involved at all; the guard alone rejects the stale SHA.
    expect(await guardPublish(store, key, "old")).toBe(false);
  });

  it("isCurrentSha is the stage-boundary check", async () => {
    const store = createInMemorySupersessionStore();
    const key = await recordEnqueue(store, repo, "sha1");
    expect(await isCurrentSha(store, key, "sha1")).toBe(true);
    await recordEnqueue(store, repo, "sha2");
    expect(await isCurrentSha(store, key, "sha1")).toBe(false);
  });
});

describe("engine poll loop honors the supersession signal", () => {
  const transport: EngineTransport = {
    submit: async () => ({ status: 202, jobId: "j" }),
    poll: async () => ({ jobId: "j", state: "running" }),
    cancel: async () => {},
  };

  it("throws EngineAbortedError when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      pollUntilDone(transport, "j", { depth: "deep", installationId: "inst_1", signal: controller.signal }),
    ).rejects.toBeInstanceOf(EngineAbortedError);
  });

  it("aborts mid-poll on a newer push", async () => {
    const controller = new AbortController();
    let polls = 0;
    const t: EngineTransport = {
      ...transport,
      poll: async () => {
        polls += 1;
        if (polls === 1) controller.abort(); // newer push arrives during the first poll
        return { jobId: "j", state: "running" };
      },
    };
    const clock = { now: () => 0, sleep: async () => {} };
    await expect(
      pollUntilDone(t, "j", { depth: "deep", installationId: "inst_1", signal: controller.signal, ...clock }),
    ).rejects.toBeInstanceOf(EngineAbortedError);
  });
});
