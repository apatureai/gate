import { existsSync, readFileSync } from "node:fs";
import { CONFIG_FILENAME, loadDesignReviewConfig, resolveConfigPath } from "@gate/config";
import { engineEndpointInvalidCheckRun, engineNotConfiguredCheckRun } from "@gate/delivery";
import { createHttpEngineTransport, createJudgmentEngineClient } from "@gate/engine";
import {
  malformedEngineEndpoint,
  missingEngineSettings,
  resolveEngineClientEnv,
} from "@gate/secrets";
import type { GateMode } from "@gate/types";
import { formatActionError } from "./action-error.js";
import { createGitHubApi } from "./github.js";
import { buildAllowlistedEnv, startLocalServer as runLocalServer, type LocalServerHandle } from "./local-serve.js";
import { runAction } from "./run.js";
import { publishSetupFailureCheckRun } from "./setup-failure.js";

/**
 * Docker entrypoint for the GitHub Action (wiring only; orchestration lives in
 * runAction). Reads inputs/context from the runner environment, builds the
 * engine client + GitHub adapter, runs the review, and exits 0. The Check Run
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
  const configPath = input("config-path") || CONFIG_FILENAME;
  const gateModeInput = input("gate-mode");
  const gh = createGitHubApi(token, { owner, repo, prNumber: pr.number, headSha: pr.head.sha });

  const resolvedConfig = resolveConfigPath(configPath, existsSync);
  if (resolvedConfig?.legacy) {
    console.warn(
      `Apature Gate: ${resolvedConfig.path} is the pre-rename config filename and will be dropped; rename it to ${CONFIG_FILENAME}.`,
    );
  }
  let configText: string | null = null;
  if (resolvedConfig) {
    try {
      configText = readFileSync(resolvedConfig.path, "utf8");
    } catch {
      configText = null; // optional file
    }
  }
  let config;
  try {
    config = loadDesignReviewConfig(configText);
  } catch (err) {
    console.error("Apature Gate config/setup error:", err);
    await publishSetupFailureCheckRun(err, {
      headSha: pr.head.sha,
      getCurrentHeadSha: gh.getCurrentHeadSha,
      publishCheckRun: gh.publishCheckRun,
    });
    return;
  }
  if (gateModeInput) config.rules.gate = gateModeInput as GateMode;

  const isFork =
    !!pr.head.repo?.full_name && !!pr.base.repo?.full_name &&
    pr.head.repo.full_name !== pr.base.repo.full_name;

  const engineEnv = resolveEngineClientEnv(process.env);
  for (const { legacyName, canonicalName } of engineEnv.legacyNamesUsed) {
    console.warn(
      `Apature Gate: ${legacyName} is deprecated and will be dropped; rename it to ${canonicalName}.`,
    );
  }

  // Gate does not ship a critique engine, so a workflow that never set
  // GATE_ENGINE_ENDPOINT is the single most likely first-run misconfiguration.
  // Before this check it fell through to `fetch("/jobs")`, whose `TypeError:
  // Failed to parse URL` was caught by the same handler as a real outage and
  // published as "The design engine is temporarily unavailable ... Gate will
  // retry", advice that can never come true. Naming the missing variable, once,
  // is the difference between a fixable setup and a check run that lies quietly
  // on every push.
  const missing = missingEngineSettings(engineEnv);
  if (missing.length > 0) {
    const run = engineNotConfiguredCheckRun(missing);
    console.error(`Apature Gate: ${run.title}. ${missing.join(", ")} not set.`);
    if ((await gh.getCurrentHeadSha()) === pr.head.sha) await gh.publishCheckRun(run);
    return;
  }

  // A set-but-unusable endpoint is the same setup problem as an unset one, and
  // was reported as its opposite: it passed the blank check above, died at the
  // first `fetch` with no HTTP status, and was published as "temporarily
  // unavailable ... Gate will retry" on every push, forever. Parsing it here,
  // beside the check that already names the variable, is what turns a permanent
  // outage story back into one line an operator can act on.
  const malformed = malformedEngineEndpoint(engineEnv);
  if (malformed) {
    const run = engineEndpointInvalidCheckRun(malformed);
    console.error(
      `Apature Gate: ${run.title}. ${malformed.variableName} is set to "${malformed.value}", and ${malformed.reason}.` +
        (malformed.suggestion ? ` Did you mean "${malformed.suggestion}"?` : ""),
    );
    if ((await gh.getCurrentHeadSha()) === pr.head.sha) await gh.publishCheckRun(run);
    return;
  }

  const engine = createJudgmentEngineClient(
    createHttpEngineTransport({
      baseUrl: engineEnv.endpoint,
      apiKey: engineEnv.apiKey,
      hmacSecret: engineEnv.hmacSecret,
    }),
  );

  // Local build-and-serve supervisor (#70): pre-bind the runner cwd + an
  // allowlisted env (never the runner's secrets) and the dev-server PORT derived
  // from the target URL. Track the live handle so a job cancellation (SIGTERM)
  // tears the server down; on the Action path, supersession IS the cancelled job.
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
  console.error(formatActionError(err));
});
