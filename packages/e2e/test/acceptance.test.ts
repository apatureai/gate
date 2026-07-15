import { createGitHubApi, GATE_GITHUB_PERMISSIONS, runAction, type ActionRunContext } from "@gate/action";
import { DEFAULT_CONFIG } from "@gate/config";
import type { CheckRun, GitHubCommentsApi, IssueComment } from "@gate/delivery";
import { createHttpEngineTransport, createJudgmentEngineClient } from "@gate/engine";
import { loadGoldenReviewResult } from "@gate/types";
import type { GateReviewResult, NormalizedDesignReviewConfig } from "@gate/types";
import { describe, expect, it, vi } from "vitest";

/**
 * TRD §11 Action-path acceptance harness. Drives the real runAction +
 * HTTP transport + contract parse against a MOCK judgment-engine (fake fetch);
 * no live model calls. M2 extends this with deployment_status, the stale-publish
 * guard, and feedback GET-inert.
 */
const golden = loadGoldenReviewResult();
const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";

/** Fake engine HTTP: POST /jobs -> 202, GET /jobs/:id -> completed + schema header. */
function mockEngineFetch(result: GateReviewResult) {
  return vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url.endsWith("/jobs") && init.method === "POST") {
      return new Response(JSON.stringify({ jobId: "job_1" }), { status: 202 });
    }
    if (/\/jobs\/job_1$/.test(url)) {
      return new Response(JSON.stringify({ jobId: "job_1", state: "completed", result }), {
        status: 200,
        headers: { "x-schema-version": "1" },
      });
    }
    throw new Error(`unexpected engine call: ${init.method ?? "GET"} ${url}`);
  });
}

function engineClient(result: GateReviewResult, fetchImpl: typeof fetch) {
  return createJudgmentEngineClient(
    createHttpEngineTransport({ baseUrl: "https://engine.test", hmacSecret: "test-secret", fetchImpl }),
  );
}

function inMemoryGitHub() {
  const store: IssueComment[] = [];
  let nextId = 1;
  const checkRuns: CheckRun[] = [];
  const comments: GitHubCommentsApi = {
    listComments: async () => store.map((c) => ({ ...c })),
    createComment: async (body) => {
      const c = { id: nextId, nodeId: `node_${nextId}`, body };
      nextId += 1;
      store.push(c);
      return c;
    },
    updateComment: async (id, body, expectedNodeId) => {
      const c = store.find((x) => x.id === id);
      if (!c || c.nodeId !== expectedNodeId) return { updated: false };
      c.body = body;
      return { updated: true };
    },
  };
  return {
    comments,
    getCurrentHeadSha: async () => ctx.pullRequest.headSha,
    publishCheckRun: async (run: CheckRun) => void checkRuns.push(run),
    store,
    checkRuns,
  };
}

const ctx: ActionRunContext = {
  installationId: "acme/web",
  repository: { owner: "acme", name: "web", defaultBranch: "main" },
  pullRequest: { number: 42, headSha: HEAD_SHA, baseSha: "def456", title: "Redesign pricing", body: null },
  isFork: false,
  previewComments: [],
};

describe("TRD §11 Action-path acceptance", () => {
  it("a PR with an explicit preview URL produces an annotated review", async () => {
    const fetchImpl = mockEngineFetch(golden) as unknown as typeof fetch;
    const gh = inMemoryGitHub();
    const outcome = await runAction(
      DEFAULT_CONFIG,
      { previewUrl: "https://preview.example.com", previewCommand: null },
      ctx,
      {
        engine: engineClient(golden, fetchImpl),
        comments: gh.comments,
        getCurrentHeadSha: gh.getCurrentHeadSha,
        publishCheckRun: gh.publishCheckRun,
        runUrl: "https://gate.app/runs/1",
      },
    );

    expect(outcome.status).toBe("reviewed");
    expect(gh.store).toHaveLength(1);
    const body = gh.store[0]!.body;
    expect(body).toContain("Apature Gate");
    expect(body).toContain(golden.findings[0]!.title); // findings rendered
    expect(body).toContain(`model ${golden.metadata.model}`); // lineage footnote
    expect(gh.checkRuns).toHaveLength(1);
    // The engine was actually called via the mock (no live model).
    expect(fetchImpl).toHaveBeenCalled();
  });

  it("a blocker in advisory mode keeps the Check Run neutral", async () => {
    const blockerResult: GateReviewResult = {
      ...golden,
      grade: "blocked",
      findings: [
        {
          id: "f_block",
          severity: "blocker",
          title: "Keyboard focus trap in modal",
          description: "Focus cannot leave the dialog.",
          route: "/",
          viewport: "desktop",
          element: ".modal",
          screenshotId: null,
          suggestion: "Restore focus on close.",
        },
      ],
      artifacts: { annotatedScreenshots: [] },
    };
    const fetchImpl = mockEngineFetch(blockerResult) as unknown as typeof fetch;
    const gh = inMemoryGitHub();

    // DEFAULT_CONFIG has rules.gate = "none" (advisory).
    const outcome = await runAction(
      DEFAULT_CONFIG,
      { previewUrl: "https://preview.example.com", previewCommand: null },
      ctx,
      {
        engine: engineClient(blockerResult, fetchImpl),
        comments: gh.comments,
        getCurrentHeadSha: gh.getCurrentHeadSha,
        publishCheckRun: gh.publishCheckRun,
      },
    );

    expect(outcome.conclusion).toBe("neutral");
    expect(gh.checkRuns[0]!.conclusion).toBe("neutral");
  });

  it("blocks only when the repo opts into gate:blockers", async () => {
    const blockerResult: GateReviewResult = { ...golden, grade: "blocked", artifacts: { annotatedScreenshots: [] } };
    const blockersConfig: NormalizedDesignReviewConfig = {
      ...DEFAULT_CONFIG,
      rules: { ...DEFAULT_CONFIG.rules, gate: "blockers" },
    };
    const fetchImpl = mockEngineFetch(blockerResult) as unknown as typeof fetch;
    const gh = inMemoryGitHub();
    const outcome = await runAction(
      blockersConfig,
      { previewUrl: "https://preview.example.com", previewCommand: null },
      ctx,
      {
        engine: engineClient(blockerResult, fetchImpl),
        comments: gh.comments,
        getCurrentHeadSha: gh.getCurrentHeadSha,
        publishCheckRun: gh.publishCheckRun,
      },
    );
    expect(outcome.conclusion).toBe("failure");
  });

  it("functions with no contents: write", () => {
    // The Action requests read-only contents; comments + checks only.
    expect(GATE_GITHUB_PERMISSIONS.contents).toBe("read");
    // The GitHub adapter exposes only comment + check-run operations.
    const gh = createGitHubApi("tok", { owner: "a", repo: "b", prNumber: 1, headSha: "s" }, (async () =>
      new Response("[]", { status: 200 })) as unknown as typeof fetch);
    expect(Object.keys(gh)).toEqual([
      "comments",
      "listPreviewComments",
      "getCurrentHeadSha",
      "publishCheckRun",
    ]);
    expect("createContent" in gh).toBe(false);
  });
});
