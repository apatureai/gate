import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { DEFAULT_CONFIG } from "@gate/config";
import type { CheckRun, GitHubCommentsApi, IssueComment, JudgmentState } from "@gate/delivery";
import { createHttpEngineTransport, createJudgmentEngineClient } from "@gate/engine";
import { missingEngineSettings, resolveEngineClientEnv } from "@gate/secrets";
import { buildAllowlistedEnv, startLocalServer } from "./local-serve.js";
import { runAction, type ActionOutcome } from "./run.js";

/**
 * The whole chain, against a real engine, with no GitHub account.
 *
 * `demo:review` proves the delivery path against a recorded critique;
 * this proves the same path against a critique service that is actually running:
 * the real HTTP transport, real HMAC signing, real `POST /jobs` + poll, real
 * capture of a real page the supervisor started, and the real schema check on
 * the way back. Only GitHub is substituted, because publishing to a pull request
 * needs an account and a token and says nothing about whether the two halves of
 * the system agree.
 *
 * It exists because "supply your own critique service" was previously untestable
 * before you had wired one into CI. This is the command that answers, in about a
 * minute and on your own machine, whether your engine and this Gate can talk.
 */

const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";

/** The fixture page the supervisor serves and the engine captures. */
export function fixturePreviewCommand(): string {
  return `node ${fileURLToPath(new URL("../fixtures/preview-app.mjs", import.meta.url))} serve`;
}

export interface LiveReviewOptions {
  outDir?: string;
  /** Where the fixture preview server should listen (default `GATE_LOCAL_SERVE_URL` or :3311). */
  previewUrl?: string;
  env?: NodeJS.ProcessEnv;
}

export interface LiveReviewResult {
  outDir: string;
  endpoint: string;
  previewUrl: string;
  outcome: ActionOutcome;
  checkRun: CheckRun;
  comment: string | null;
  commentPath: string;
  checkRunPath: string;
}

/** The setup error this command raises before touching the network. */
export class LiveReviewConfigError extends Error {
  constructor(readonly missing: string[]) {
    super(
      `No engine to review against. Set ${missing.join(" and ")}.\n\n` +
        "Gate ships no critique service. Start one and point this at it:\n" +
        "  git clone https://github.com/apatureai/verdict.git && cd verdict\n" +
        "  pnpm install --frozen-lockfile && pnpm browser:install && pnpm build\n" +
        '  export ENGINE_HMAC_SECRET="$(openssl rand -hex 32)"\n' +
        "  node packages/serve/dist/main.js --port 8791 --model mock",
    );
    this.name = "LiveReviewConfigError";
  }
}

/** In-memory stand-in for the GitHub REST surface, so no account is needed. */
function inMemoryGitHub() {
  const store: IssueComment[] = [];
  const checkRuns: CheckRun[] = [];
  let nextId = 1;
  const comments: GitHubCommentsApi = {
    listComments: async () => store.map((c) => ({ ...c })),
    createComment: async (body) => {
      const comment = { id: nextId, nodeId: `node_${nextId}`, body };
      nextId += 1;
      store.push(comment);
      return comment;
    },
    updateComment: async (id, body, expectedNodeId) => {
      const comment = store.find((c) => c.id === id);
      if (!comment || comment.nodeId !== expectedNodeId) return { updated: false };
      comment.body = body;
      return { updated: true };
    },
  };
  return { comments, store, checkRuns, publishCheckRun: async (run: CheckRun) => void checkRuns.push(run) };
}

export async function runLiveReview(options: LiveReviewOptions = {}): Promise<LiveReviewResult> {
  const env = options.env ?? process.env;
  const engineEnv = resolveEngineClientEnv(env);
  const missing = missingEngineSettings(engineEnv);
  if (missing.length > 0) throw new LiveReviewConfigError(missing);

  const outDir = resolve(options.outDir ?? "out");
  await mkdir(outDir, { recursive: true });
  const previewUrl = options.previewUrl ?? env.GATE_LOCAL_SERVE_URL ?? "http://127.0.0.1:3311";

  const engine = createJudgmentEngineClient(
    createHttpEngineTransport({
      baseUrl: engineEnv.endpoint,
      ...(engineEnv.apiKey ? { apiKey: engineEnv.apiKey } : {}),
      ...(engineEnv.hmacSecret ? { hmacSecret: engineEnv.hmacSecret } : {}),
      // A real capture takes longer than a control-plane call; this is the
      // per-request ceiling, not the review deadline.
      requestTimeoutMs: 120_000,
    }),
  );

  const gh = inMemoryGitHub();
  const outcome = await runAction(
    DEFAULT_CONFIG,
    { previewUrl: null, previewCommand: fixturePreviewCommand(), localServeUrl: previewUrl },
    {
      installationId: "apatureai/gate",
      repository: { owner: "apatureai", name: "gate", defaultBranch: "main" },
      pullRequest: {
        number: 7,
        headSha: HEAD_SHA,
        baseSha: "fedcba9876543210fedcba9876543210fedcba98",
        title: "Refresh the pricing page",
        body: null,
      },
      isFork: false,
      previewComments: [],
    },
    {
      engine,
      comments: gh.comments,
      getCurrentHeadSha: async () => HEAD_SHA,
      publishCheckRun: gh.publishCheckRun,
      startLocalServer: async (command, opts) => {
        const childEnv = buildAllowlistedEnv();
        try {
          const port = new URL(opts.url).port;
          if (port) childEnv.PORT = port;
        } catch {
          /* non-URL: let the command pick its own port */
        }
        return startLocalServer(command, { ...opts, cwd: process.cwd(), env: childEnv });
      },
    },
  );

  const checkRun = gh.checkRuns.at(-1);
  if (!checkRun) throw new Error("the live review produced no Check Run");
  const comment = gh.store.at(-1)?.body ?? null;
  const commentPath = resolve(outDir, "live-review-comment.md");
  const checkRunPath = resolve(outDir, "live-check-run.json");
  await writeFile(commentPath, comment ?? "(no comment was published)");
  await writeFile(checkRunPath, `${JSON.stringify(checkRun, null, 2)}\n`);

  return {
    outDir,
    endpoint: engineEnv.endpoint,
    previewUrl,
    outcome,
    checkRun,
    comment,
    commentPath,
    checkRunPath,
  };
}

/** One line saying what the run proved, in the vocabulary of the judgment stamp. */
function verdictLine(judgment: JudgmentState | undefined): string {
  switch (judgment) {
    case "model_backed":
      return "a model judged the page; the grade above is a review";
    case "unjudged":
      return "NOTHING judged the page; the engine has no model configured, and Gate withheld the grade";
    case "unconfirmed":
      return "the engine could not confirm a model judged the page; Gate withheld the grade";
    default:
      return "the engine did not state whether a model judged the page";
  }
}

/** Render the run as the transcript the CLI prints. Pure. */
export function formatLiveReviewResult(result: LiveReviewResult, cwd = process.cwd()): string {
  const rel = (path: string): string => (path.startsWith(cwd) ? `.${path.slice(cwd.length)}` : path);
  return [
    "Gate live review (real engine, real capture, GitHub substituted)",
    "",
    `  engine          ${result.endpoint}`,
    `  preview         ${result.previewUrl}  (fixture app, started by the supervisor)`,
    `  action status   ${result.outcome.status} · comment ${result.outcome.commentAction ?? "none"}`,
    `  check run       ${result.checkRun.conclusion}, ${result.checkRun.title}`,
    `  judgment        ${result.outcome.judgment ?? "not stated"}: ${verdictLine(result.outcome.judgment)}`,
    "",
    "  wrote",
    `    ${rel(result.commentPath)}  (the sticky PR comment, verbatim)`,
    `    ${rel(result.checkRunPath)}  (the Check Run payload)`,
    "",
  ].join("\n");
}
