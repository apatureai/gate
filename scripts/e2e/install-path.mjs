#!/usr/bin/env node
// install-path e2e: proves the built Action image runs in an ADOPTER's repo,
// not only in gate's own checkout.
//
// The failure this guards against: apatureai/gate@v1 shipped with a *relative*
// ENTRYPOINT (`node packages/action/dist/main.js`). GitHub runs a Docker action
// with `--workdir /github/workspace` — the adopter's checkout — so the relative
// path resolved against a tree that does not contain Gate's code, and every
// install crashed with "Cannot find module .../packages/action/dist/main.js"
// before it could publish even the neutral "Engine not configured" Check Run.
//
// What this harness does:
//   1. Builds Dockerfile.action for linux/amd64 (the real runner arch).
//   2. Creates a scratch repo fixture with a DIFFERENT directory layout than
//      gate (no packages/, no dist/ — just an app the way an adopter's repo
//      looks), and a pull_request event payload.
//   3. Runs the image exactly as GitHub would: `--workdir /github/workspace`
//      with the fixture mounted there, GITHUB_API_URL pointed at a mock GitHub
//      API on the host, and NO engine configured.
//   4. Asserts the container exits 0 (the Check Run is the gate, never the exit
//      code) and that it POSTed a neutral "Engine not configured" Check Run for
//      the PR's head sha — the first thing an evaluator must see.
//
// Run: node scripts/e2e/install-path.mjs
// Env: SKIP_BUILD=1 reuse an existing IMAGE tag; IMAGE=<tag> override the tag;
//      KEEP_FIXTURE=1 leave the scratch dir for inspection.

import { Buffer } from "node:buffer";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const IMAGE = process.env.IMAGE ?? "gate-action:install-path-e2e";
const PLATFORM = "linux/amd64";

// A head sha the mock will echo back from GET /pulls/:n so main.ts's pre-publish
// staleness guard (getCurrentHeadSha() === pr.head.sha) passes.
const HEAD_SHA = "7a7e53ab18bb24bdb63d097c0c39f01981721737";
const OWNER = "apatureai";
const REPO = "gallery";

const log = (...a) => console.log("[install-path-e2e]", ...a);
const die = (msg) => {
  console.error(`\n[install-path-e2e] FAIL: ${msg}\n`);
  process.exit(1);
};

function run(cmd, args, opts = {}) {
  log("$", cmd, args.join(" "));
  return spawnSync(cmd, args, { encoding: "utf8", ...opts });
}

/**
 * Async twin of `run`, for the container itself.
 *
 * The mock GitHub API is an http server in THIS process, so the container can
 * only be waited on asynchronously: `spawnSync` blocks this event loop, the
 * mock never accepts the connection, and the run "times out" having served
 * nothing — a harness deadlock that looks exactly like a network failure.
 */
function runAsync(cmd, args, { timeoutMs }) {
  log("$", cmd, args.join(" "));
  return new Promise((resolveRun) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolveRun({ status: null, stdout, stderr, error });
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolveRun({
        status,
        stdout,
        stderr,
        error: timedOut ? Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }) : undefined,
      });
    });
  });
}

// 1. Build the action image for the real runner arch. -----------------------
if (process.env.SKIP_BUILD === "1") {
  log(`SKIP_BUILD=1 — reusing image ${IMAGE}`);
} else {
  const build = run(
    "docker",
    ["build", "--platform", PLATFORM, "-f", "Dockerfile.action", "-t", IMAGE, "."],
    { cwd: REPO_ROOT, stdio: "inherit" },
  );
  if (build.status !== 0) die(`docker build exited ${build.status}`);
}

// 2. Build a scratch fixture with an adopter-shaped layout. ------------------
// Deliberately unlike gate: an app at the root with apps/ and src/, and NO
// packages/action/dist anywhere. If the entrypoint resolved against cwd this
// tree would make it crash, which is exactly what we are proving it does not.
const fixture = mkdtempSync(join(tmpdir(), "gate-adopter-"));
mkdirSync(join(fixture, "apps", "marketing"), { recursive: true });
mkdirSync(join(fixture, "src", "components"), { recursive: true });
writeFileSync(
  join(fixture, "package.json"),
  JSON.stringify(
    { name: "adopter-app", private: true, dependencies: { react: "^19.0.0" } },
    null,
    2,
  ),
);
writeFileSync(join(fixture, ".gate.yml"), "rules:\n  gate: nits\n");
writeFileSync(join(fixture, "apps", "marketing", "index.html"), "<!doctype html><title>adopter</title>\n");
writeFileSync(
  join(fixture, "event.json"),
  JSON.stringify(
    {
      pull_request: {
        number: 1,
        title: "A change an adopter opened",
        body: null,
        head: { sha: HEAD_SHA, repo: { full_name: `${OWNER}/${REPO}`, fork: false } },
        base: { sha: "1dc75208d9384b2bc6195d5cda5dbb3359781472", repo: { full_name: `${OWNER}/${REPO}` } },
      },
    },
    null,
    2,
  ),
);

// 3. Mock GitHub API: echo the head sha, capture the Check Run POST. ---------
let checkRunBody = null;
const requests = [];
const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    requests.push(`${req.method} ${req.url}`);
    if (req.method === "POST" && req.url.endsWith("/check-runs")) {
      try {
        checkRunBody = JSON.parse(body);
      } catch {
        checkRunBody = { _unparseable: body };
      }
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: 1 }));
      return;
    }
    if (req.method === "GET" && /\/pulls\/\d+$/.test(req.url)) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ head: { sha: HEAD_SHA } }));
      return;
    }
    // Any other read (e.g. comments) is not on the not-configured path; answer
    // with an empty list so an unexpected call can never wedge the run.
    res.writeHead(200, { "content-type": "application/json" });
    res.end(req.method === "GET" ? "[]" : "{}");
  });
});

await new Promise((r) => server.listen(0, "0.0.0.0", r));
const port = server.address().port;
log(`mock GitHub API on host port ${port}`);

// 4. Run the container the way GitHub does. ----------------------------------
// --workdir /github/workspace is GitHub's own override; the fixture is mounted
// there. The container has to reach the mock running on the host:
//   - On a native Linux docker engine (the GitHub runner) `--network host`
//     shares the host netns, so plain 127.0.0.1 reaches the mock — the most
//     reliable option in CI, and where this job is the source of truth.
//   - On Docker Desktop (macOS/Windows) `--network host` is not equivalent, so
//     fall back to the built-in host.docker.internal (best-effort locally).
const onLinux = platform() === "linux";
const netArgs = onLinux ? ["--network", "host"] : [];
const apiHost = onLinux ? "127.0.0.1" : "host.docker.internal";
// A network failure must fail loudly, never hang the job: cap the run.
const RUN_TIMEOUT_MS = 180_000;
let result;
try {
  result = await runAsync(
    "docker",
    [
      "run",
      "--rm",
      "--platform",
      PLATFORM,
      ...netArgs,
      "--workdir",
      "/github/workspace",
      "-v",
      `${fixture}:/github/workspace`,
      "-e",
      `GITHUB_REPOSITORY=${OWNER}/${REPO}`,
      "-e",
      "GITHUB_EVENT_PATH=/github/workspace/event.json",
      "-e",
      `GITHUB_API_URL=http://${apiHost}:${port}`,
      "-e",
      "GITHUB_TOKEN=dummy-token-for-e2e",
      "-e",
      "GITHUB_DEFAULT_BRANCH=main",
      IMAGE,
    ],
    { timeoutMs: RUN_TIMEOUT_MS },
  );
} finally {
  server.close();
  if (process.env.KEEP_FIXTURE === "1") log(`fixture kept at ${fixture}`);
  else rmSync(fixture, { recursive: true, force: true });
}
if (result.error?.code === "ETIMEDOUT") {
  die(`container did not exit within ${RUN_TIMEOUT_MS}ms (could not reach the mock GitHub API?)`);
}

const stdout = result.stdout ?? "";
const stderr = result.stderr ?? "";
if (stdout.trim()) log("container stdout:\n" + stdout.trim());
if (stderr.trim()) log("container stderr:\n" + stderr.trim());
log("mock received:", requests.length ? requests.join(", ") : "(nothing)");

// 5. Assertions. ------------------------------------------------------------
const combined = stdout + stderr;
if (/Cannot find module/i.test(combined)) {
  die('container logged "Cannot find module" — the entrypoint resolved against the adopter checkout (the v1 install bug)');
}
if (result.status !== 0) {
  die(`container exited ${result.status}; expected 0 (the Check Run is the gate, never the exit code)`);
}
if (!checkRunBody) {
  die("no Check Run was POSTed — the adopter would see nothing on their PR");
}
if (checkRunBody.output?.title !== "Engine not configured") {
  die(`Check Run title was ${JSON.stringify(checkRunBody.output?.title)}, expected "Engine not configured"`);
}
if (checkRunBody.conclusion !== "neutral") {
  die(`Check Run conclusion was ${JSON.stringify(checkRunBody.conclusion)}, expected "neutral" (must never read as a pass)`);
}
if (checkRunBody.head_sha !== HEAD_SHA) {
  die(`Check Run head_sha was ${JSON.stringify(checkRunBody.head_sha)}, expected ${HEAD_SHA}`);
}
if (typeof checkRunBody.output?.summary === "string" && !checkRunBody.output.summary.includes("This is not a pass.")) {
  die("Check Run summary did not carry the \"This is not a pass.\" line");
}

log("PASS — image runs from an adopter layout and published a neutral \"Engine not configured\" Check Run");
log(`  conclusion=${checkRunBody.conclusion} title=${JSON.stringify(checkRunBody.output.title)} head_sha=${checkRunBody.head_sha}`);
process.exit(0);
