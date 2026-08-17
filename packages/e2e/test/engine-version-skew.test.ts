import { runAction, type ActionRunContext } from "@gate/action";
import { DEFAULT_CONFIG } from "@gate/config";
import type { CheckRun, GitHubCommentsApi, IssueComment } from "@gate/delivery";
import { createHttpEngineTransport, createJudgmentEngineClient } from "@gate/engine";
import { loadGoldenReviewResult, type GateReviewResult, type NormalizedDesignReviewConfig } from "@gate/types";
import { describe, expect, it } from "vitest";

/**
 * Gate and the critique engine deploy separately, so every field either side
 * gained has to survive meeting a peer that has never heard of it.
 *
 * Two fields are new: `componentLibraries` on the request (the ids Gate read out
 * of the repository, which the hosted engine has no checkout to detect) and
 * `config.verifyStability` (the per-review form of the engine's
 * `--verify-stability`). This file runs the whole Action path across the version
 * boundary in both directions, against a mock engine that behaves like the peer
 * being simulated.
 */

const golden = loadGoldenReviewResult();
const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";

/** The determinism-check clause a NEWER engine puts in its page-health footnote. */
const VERIFIED_FOOTNOTE = "Page health: determinism check: 4 page(s) captured twice, all byte-identical.";

interface MockEngine {
  client: ReturnType<typeof createJudgmentEngineClient>;
  /** Every submitted request body, as the engine received it. */
  requests: Record<string, unknown>[];
}

/**
 * A mock engine that parses the request the way the simulated peer does.
 *
 * `known` is the set of top-level request fields the engine understands. An
 * OLDER engine is one whose parser does not name the new ones: like the real
 * contract (a non-strict Zod object), it strips what it does not know rather
 * than rejecting the request.
 */
function mockEngine(result: GateReviewResult, known?: readonly string[]): MockEngine {
  const requests: Record<string, unknown>[] = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    if (url.endsWith("/jobs") && init.method === "POST") {
      const submitted = JSON.parse(String(init.body)) as { request: Record<string, unknown> };
      const request = known
        ? Object.fromEntries(Object.entries(submitted.request).filter(([key]) => known.includes(key)))
        : submitted.request;
      requests.push(request);
      return new Response(JSON.stringify({ jobId: "job_1" }), { status: 202 });
    }
    return new Response(JSON.stringify({ jobId: "job_1", state: "completed", result }), {
      status: 200,
      headers: { "x-schema-version": "1" },
    });
  }) as unknown as typeof fetch;
  return {
    client: createJudgmentEngineClient(createHttpEngineTransport({ baseUrl: "https://engine.test", fetchImpl })),
    requests,
  };
}

/** The request fields an engine deployed before either of these fields existed knows. */
const PRE_CHANGE_REQUEST_FIELDS = [
  "installationId",
  "repository",
  "pullRequest",
  "preview",
  "config",
  "publishMode",
  "depth",
  "previewBuildFacts",
] as const;

function inMemoryGitHub() {
  const store: IssueComment[] = [];
  const checkRuns: CheckRun[] = [];
  let id = 1;
  const comments: GitHubCommentsApi = {
    listComments: async () => store.map((c) => ({ ...c })),
    createComment: async (body) => {
      const comment = { id, nodeId: `n${id}`, body };
      id += 1;
      store.push(comment);
      return comment;
    },
    updateComment: async (cid, body, expected) => {
      const comment = store.find((x) => x.id === cid);
      if (!comment || comment.nodeId !== expected) return { updated: false };
      comment.body = body;
      return { updated: true };
    },
  };
  return { comments, publishCheckRun: async (run: CheckRun) => void checkRuns.push(run), store, checkRuns };
}

const baseCtx: ActionRunContext = {
  installationId: "acme/web",
  repository: { owner: "acme", name: "web", defaultBranch: "main" },
  pullRequest: { number: 7, headSha: HEAD_SHA, baseSha: "main0", title: "Tweak pricing", body: null },
  isFork: false,
  previewComments: [],
};

async function review(
  engine: MockEngine,
  config: NormalizedDesignReviewConfig,
  ctx: ActionRunContext,
) {
  const gh = inMemoryGitHub();
  const outcome = await runAction(
    config,
    { previewUrl: "https://acme-web-pr7.vercel.app", previewCommand: null },
    ctx,
    {
      engine: engine.client,
      comments: gh.comments,
      getCurrentHeadSha: async () => ctx.pullRequest.headSha,
      publishCheckRun: gh.publishCheckRun,
    },
  );
  return { outcome, gh };
}

describe("a newer Gate against an older engine", () => {
  it("still gets a published review when the engine drops the fields it does not know", async () => {
    const engine = mockEngine(golden, PRE_CHANGE_REQUEST_FIELDS);
    const { outcome, gh } = await review(
      engine,
      { ...DEFAULT_CONFIG, verifyStability: true },
      { ...baseCtx, componentLibraries: ["mui"] },
    );

    // The engine never saw `componentLibraries`, and `verifyStability` rode
    // inside a config object whose other fields it parsed as usual.
    expect(engine.requests[0]).not.toHaveProperty("componentLibraries");
    expect(engine.requests[0]?.config).toBeDefined();
    // And the review is a review: nothing about sending a field the peer does
    // not know can cost a pull request its comment or its Check Run.
    expect(outcome.status).toBe("reviewed");
    expect(gh.store[0]?.body).toContain(golden.findings[0]!.title);
  });

  it("sends the older engine a body it would have sent before, when nothing asked for anything new", async () => {
    const newer = mockEngine(golden);
    await review(newer, DEFAULT_CONFIG, baseCtx);
    const older = mockEngine(golden, PRE_CHANGE_REQUEST_FIELDS);
    await review(older, DEFAULT_CONFIG, baseCtx);
    // Identical, field for field: an installation that opted into nothing has
    // nothing new on the wire for a peer to ignore in the first place.
    expect(newer.requests[0]).toEqual(older.requests[0]);
  });
});

describe("an older Gate against a newer engine", () => {
  it("reviews normally while sending neither new field", async () => {
    const engine = mockEngine(golden);
    const { outcome } = await review(engine, DEFAULT_CONFIG, baseCtx);
    expect(engine.requests[0]).not.toHaveProperty("componentLibraries");
    expect(engine.requests[0]?.config).not.toHaveProperty("verifyStability");
    expect(outcome.status).toBe("reviewed");
  });

  it("renders the newer engine's determinism-check footnote without treating it as a finding", async () => {
    // A newer engine states a check that ran and passed, which is the one
    // page-health clause that is good news. Gate shows it as capture health and
    // changes nothing about the verdict, exactly as it does for the bad-news
    // clauses.
    const result: GateReviewResult = {
      ...golden,
      artifacts: { ...golden.artifacts, pageHealthFootnote: VERIFIED_FOOTNOTE },
    };
    const engine = mockEngine(result);
    const { outcome, gh } = await review(engine, DEFAULT_CONFIG, baseCtx);

    expect(gh.store[0]?.body).toContain("Capture health:");
    expect(gh.store[0]?.body).toContain("all byte-identical");
    expect(outcome.conclusion).toBe(
      (await review(mockEngine(golden), DEFAULT_CONFIG, baseCtx)).outcome.conclusion,
    );
    expect(gh.checkRuns.at(-1)?.summary).toContain("byte-identical");
  });
});
