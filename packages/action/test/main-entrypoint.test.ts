import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CheckRun } from "@gate/delivery";
import { canonicalReviewIdentity, type JudgmentEngineClient } from "@gate/engine";
import type * as EngineModule from "@gate/engine";
import { loadGoldenReviewResult } from "@gate/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Action's composition root, run as the container runs it.
 *
 * `resolveActionConfig` can be correct in every unit while `main.ts` calls
 * `loadDesignReviewConfig` directly and never applies the workflow's
 * `gate-mode` at all, and nothing about that state looks broken: the review
 * runs, the comment posts, the check is green, and the only thing missing is
 * the merge gate the repository asked for. So the wire is asserted here on the
 * outcome, by driving the real entrypoint through a fake GitHub and a fake
 * engine and reading the conclusion it publishes.
 */

const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";
const golden = loadGoldenReviewResult();

const published: CheckRun[] = [];
const gh = {
  comments: {
    listComments: vi.fn(async () => []),
    createComment: vi.fn(async (body: string) => ({ id: 1, nodeId: "n1", body })),
    updateComment: vi.fn(async () => ({ updated: true })),
  },
  listPreviewComments: vi.fn(async () => []),
  getCurrentHeadSha: vi.fn(async () => HEAD_SHA),
  publishCheckRun: vi.fn(async (run: CheckRun) => void published.push(run)),
};

vi.mock("../src/github.js", () => ({ createGitHubApi: () => gh }));

type ReviewContext = Parameters<JudgmentEngineClient["review"]>[0];

vi.mock("@gate/engine", async (importOriginal) => {
  const actual = await importOriginal<typeof EngineModule>();
  return {
    ...actual,
    createHttpEngineTransport: () => ({}),
    createJudgmentEngineClient: () => ({
      review: async (reviewCtx: ReviewContext) => ({
        status: "completed" as const,
        result: { ...golden, grade: "blocked" as const },
        jobId: "j",
        reviewIdentity: canonicalReviewIdentity(reviewCtx),
      }),
      cancel: async () => {},
    }),
  };
});

const ORIGINAL_ENV = { ...process.env };

function writeEventPayload(dir: string): string {
  const path = join(dir, "event.json");
  writeFileSync(
    path,
    JSON.stringify({
      pull_request: {
        number: 42,
        title: "Redesign",
        body: null,
        head: { sha: HEAD_SHA, repo: { full_name: "acme/web" } },
        base: { sha: "fedcba9876543210fedcba9876543210fedcba98", repo: { full_name: "acme/web" } },
      },
    }),
  );
  return path;
}

/** Run the entrypoint exactly as the container does: import it and let it run. */
async function runEntrypoint(): Promise<CheckRun[]> {
  published.length = 0;
  vi.resetModules();
  await import("../src/main.js");
  await vi.waitFor(() => expect(gh.publishCheckRun).toHaveBeenCalled());
  return published;
}

describe("the Action entrypoint", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "gate-main-"));
    const configPath = join(workspace, ".gate.yml");
    writeFileSync(configPath, "rules:\n  gate: blockers\n");
    process.env.GITHUB_REPOSITORY = "acme/web";
    process.env.GITHUB_EVENT_PATH = writeEventPayload(workspace);
    process.env.INPUT_CONFIG_PATH = configPath;
    process.env.INPUT_PREVIEW_URL = "https://preview.example.com";
    process.env.INPUT_GITHUB_TOKEN = "t";
    process.env.GATE_ENGINE_ENDPOINT = "http://127.0.0.1:8791";
    process.env.GATE_ENGINE_HMAC_SECRET = "s";
    delete process.env.INPUT_GATE_MODE;
    delete process.env.INPUT_PREVIEW_COMMAND;
    for (const spy of [gh.publishCheckRun, gh.getCurrentHeadSha, gh.listPreviewComments, gh.comments.createComment, gh.comments.updateComment, gh.comments.listComments]) {
      spy.mockClear();
    }
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
  });

  it("carries rules.gate from .gate.yml into the published Check Run", async () => {
    // The whole point: no gate-mode is set on the workflow, so the file decides,
    // and a blocked grade under `gate: blockers` fails the check. Drop the
    // gate-mode wiring in main.ts and this stays green at "neutral".
    const [run] = await runEntrypoint();
    expect(run?.conclusion).toBe("failure");
  });

  it("lets the workflow's gate-mode override that file when one is set", async () => {
    process.env.INPUT_GATE_MODE = "none";
    const [run] = await runEntrypoint();
    expect(run?.conclusion).toBe("neutral");
  });

  it("publishes a neutral setup failure naming gate-mode when the input is not a gate mode", async () => {
    process.env.INPUT_GATE_MODE = "blocker";
    const [run] = await runEntrypoint();
    expect(run?.conclusion).toBe("neutral");
    expect(run?.summary).toContain("gate-mode");
    expect(run?.summary).toContain("blocker");
    // It never reached the engine, so it must not read as a review of anything.
    expect(gh.comments.createComment).not.toHaveBeenCalled();
  });
});
