import { readFileSync } from "node:fs";
import { loadDesignReviewConfig } from "@gate/config";
import { createHttpEngineTransport, createJudgmentEngineClient } from "@gate/engine";
import type { GateMode } from "@gate/types";
import { createGitHubApi } from "./github.js";
import { buildAllowlistedEnv, startLocalServer as runLocalServer, type LocalServerHandle } from "./local-serve.js";
import { runAction } from "./run.js";

/**
 * Docker entrypoint for the GitHub Action (wiring only; orchestration lives in
 * runAction). Reads inputs/context from the runner environment, builds the
 * engine client + GitHub adapter, runs the review, and exits 0 — the Check Run
 * (not the action exit code) is the gate, so the PR is never failed by default.
 */
function input(name: string): string {
  return process.env[`INPUT_${name.toUpperCase().replace(/-/g, "_")}`]?.trim() ?? "";
}

async function main(): Promise<void> {
  const [owner, repo] = (process.env.GITHUB_REPOSITORY ?? "/").split("/");
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!owner || !repo || !eventPath) throw new Error("missing GitHub Action context");

  const event = JSON.parse(readFileSync(eventPath, "utf8")) as {
    pull_request?: {
      number: number;
      title: string;
      body: string | null;
      head: { sha: string; repo?: { full_name?: string } | null };
      base: { sha: string; repo?: { full_name?: string } | null };
    };
  };
  const pr = event.pull_request;
  if (!pr) {
    console.log("Not a pull_request event; skipping.");
    return;
  }

  const token = input("github-token") || (process.env.GITHUB_TOKEN ?? "");
  const configPath = input("config-path") || ".designreview.yml";
  const gateModeInput = input("gate-mode");

  let configText: string | null = null;
  try {
    configText = readFileSync(configPath, "utf8");
  } catch {
    configText = null; // optional file
  }
  const config = loadDesignReviewConfig(configText);
  if (gateModeInput) config.rules.gate = gateModeInput as GateMode;

  const isFork =
    !!pr.head.repo?.full_name && !!pr.base.repo?.full_name &&
    pr.head.repo.full_name !== pr.base.repo.full_name;

  const gh = createGitHubApi(token, { owner, repo, prNumber: pr.number, headSha: pr.head.sha });

  const engine = createJudgmentEngineClient(
    createHttpEngineTransport({
      baseUrl: process.env.JUDGMENT_ENGINE_ENDPOINT ?? "",
      apiKey: process.env.JUDGMENT_ENGINE_API_KEY,
      hmacSecret: process.env.JUDGMENT_ENGINE_HMAC_SECRET,
    }),
  );

  // Local build-and-serve supervisor (#70): pre-bind the runner cwd + an
  // allowlisted env (never the runner's secrets) and the dev-server PORT derived
  // from the target URL. Track the live handle so a job cancellation (SIGTERM)
  // tears the server down — on the Action path, supersession IS the cancelled job.
  let activeServer: LocalServerHandle | null = null;
  const startLocalServer = async (
    command: string,
    opts: { url: string; readyPath?: string | null; readyStatus?: number[] | null },
  ) => {
    const env = buildAllowlistedEnv();
    try {
      const port = new URL(opts.url).port;
      if (port) env.PORT = port;
    } catch {
      /* non-URL: let the command pick its own port */
    }
    const result = await runLocalServer(command, {
      url: opts.url,
      readyPath: opts.readyPath,
      readyStatus: opts.readyStatus,
      cwd: process.cwd(),
      env,
    });
    if (result.ok) activeServer = result.server;
    return result;
  };
  const teardownOnSignal = (code: number): void => {
    void Promise.resolve(activeServer?.stop()).finally(() => process.exit(code));
  };
  process.once("SIGINT", () => teardownOnSignal(130));
  process.once("SIGTERM", () => teardownOnSignal(143));

  const outcome = await runAction(
    config,
    {
      previewUrl: input("preview-url") || null,
      previewCommand: input("preview-command") || null,
      localServeUrl: process.env.GATE_LOCAL_SERVE_URL ?? null,
    },
    {
      installationId: `${owner}/${repo}`,
      repository: { owner, name: repo, defaultBranch: process.env.GITHUB_DEFAULT_BRANCH ?? "main" },
      pullRequest: {
        number: pr.number,
        headSha: pr.head.sha,
        baseSha: pr.base.sha,
        title: pr.title,
        body: pr.body,
      },
      isFork,
      previewComments: await gh.listPreviewComments(),
    },
    {
      engine,
      comments: gh.comments,
      getCurrentHeadSha: gh.getCurrentHeadSha,
      publishCheckRun: gh.publishCheckRun,
      startLocalServer,
    },
  );

  console.log(`Apature Gate: ${outcome.status} (check run: ${outcome.conclusion})`);
}

main().catch((err: unknown) => {
  // Never fail the PR on an internal error; surface it in the log.
  console.error("Apature Gate action error:", err);
});
