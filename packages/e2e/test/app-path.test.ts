import { DEFAULT_CONFIG } from "@gate/config";
import type { CheckRun, GitHubCommentsApi, IssueComment } from "@gate/delivery";
import { createHttpEngineTransport, createJudgmentEngineClient } from "@gate/engine";
import {
  createDeploymentStatusHandler,
  createInMemoryFeedbackStore,
  createFeedbackSink,
  createInMemoryFullReviewWindow,
  createInMemoryReviewWorker,
  createInMemorySupersessionStore,
  hydrateReviewContext,
  type PullRequestDetails,
  runHostedReview,
} from "@gate/service";
import { loadGoldenReviewResult } from "@gate/types";
import type { GateReviewResult } from "@gate/types";
import { describe, expect, it } from "vitest";

/**
 * App-path end-to-end integration (#23/#55/#3/#48/#4/#41 wired together) against
 * the MOCK engine: deployment_status webhook -> resolve+record current_sha ->
 * enqueue -> worker hydrates the IDs-only payload -> runHostedReview publishes.
 */
const golden = loadGoldenReviewResult();
const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";
const tick = () => new Promise((r) => setTimeout(r, 0));

function mockEngine(result: GateReviewResult) {
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    if (url.endsWith("/jobs") && init.method === "POST") {
      return new Response(JSON.stringify({ jobId: "job_1" }), { status: 202 });
    }
    return new Response(JSON.stringify({ jobId: "job_1", state: "completed", result }), {
      status: 200,
      headers: { "x-schema-version": "1" },
    });
  }) as unknown as typeof fetch;
  return createJudgmentEngineClient(createHttpEngineTransport({ baseUrl: "https://engine.test", fetchImpl }));
}

function inMemoryGitHub() {
  const store: IssueComment[] = [];
  let id = 1;
  const checkRuns: CheckRun[] = [];
  const comments: GitHubCommentsApi = {
    listComments: async () => store.map((c) => ({ ...c })),
    createComment: async (body) => {
      const c = { id, nodeId: `n${id}`, body };
      id += 1;
      store.push(c);
      return c;
    },
    updateComment: async (cid, body, expected) => {
      const c = store.find((x) => x.id === cid);
      if (!c || c.nodeId !== expected) return { updated: false };
      c.body = body;
      return { updated: true };
    },
  };
  return { comments, publishCheckRun: async (r: CheckRun) => void checkRuns.push(r), store, checkRuns };
}

const prDetails: PullRequestDetails = {
  defaultBranch: "main",
  title: "Redesign pricing",
  body: null,
  isFork: false,
};

describe("App path end-to-end (deployment_status -> worker -> runHostedReview)", () => {
  it("reviews and publishes from a deployment_status webhook", async () => {
    const supersession = createInMemorySupersessionStore();
    const windowStore = createInMemoryFullReviewWindow();
    const feedbackStore = createInMemoryFeedbackStore();
    const gh = inMemoryGitHub();
    const worker = createInMemoryReviewWorker();

    worker.onJob(async (job, ctx) => {
      const reviewCtx = hydrateReviewContext(job, prDetails);
      await runHostedReview(DEFAULT_CONFIG, reviewCtx, {
        supersession,
        windowStore,
        engine: mockEngine(golden),
        comments: gh.comments,
        publishCheckRun: gh.publishCheckRun,
        feedback: createFeedbackSink(feedbackStore),
        signal: ctx.signal,
        runUrl: "https://gate.app/runs/1",
      });
    });

    const handler = createDeploymentStatusHandler({
      supersession,
      worker,
      resolvePullRequest: async (_o, _n, sha) => ({ number: 42, headSha: sha, baseSha: "base0" }),
    });

    await handler({
      installation: { id: 1 },
      repository: { name: "web", owner: { login: "acme" } },
      deployment_status: { state: "success", environment_url: "https://acme.vercel.app" },
      deployment: { id: 7, sha: HEAD_SHA, environment: "Preview" },
    });
    await tick();

    expect(await supersession.getCurrentSha("sha:acme/web#42")).toBe(HEAD_SHA);
    expect(gh.store).toHaveLength(1);
    expect(gh.store[0]?.body).toContain(golden.findings[0]!.title);
    expect(gh.checkRuns).toHaveLength(1);
    expect(feedbackStore.events).toHaveLength(1);
    expect(await windowStore.getLastFullReviewAt({ owner: "acme", name: "web", prNumber: 42 })).not.toBeNull();
  });

  it("ignores a deployment_status with no installation id", async () => {
    const worker = createInMemoryReviewWorker();
    let ran = false;
    worker.onJob(async () => void (ran = true));
    const handler = createDeploymentStatusHandler({
      supersession: createInMemorySupersessionStore(),
      worker,
      resolvePullRequest: async (_o, _n, sha) => ({ number: 42, headSha: sha, baseSha: "b" }),
    });
    await handler({
      repository: { name: "web", owner: { login: "acme" } },
      deployment_status: { state: "success", environment_url: "https://acme.vercel.app" },
      deployment: { id: 7, sha: "abc", environment: "Preview" },
    });
    await tick();
    expect(ran).toBe(false); // no installation.id -> not enqueued
  });
});
