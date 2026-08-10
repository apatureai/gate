import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { PreviewBuildFact } from "@gate/types";
import { parsePreviewBuildFacts } from "./build-facts.js";
import { buildAllowlistedEnv, startLocalServer } from "./local-serve.js";
import {
  buildResourceCappedCommand,
  DEFAULT_RESOURCE_LIMITS,
  resolveCapShell,
  type ResourceLimits,
} from "./resource-cap.js";

/**
 * Standalone, credential-free exercise of the local-serve supervisor
 * (`startLocalServer`) against the fixture app in `packages/action/fixtures`.
 *
 * It is the part of the Action path that can be demonstrated on its own: the
 * hosted review needs a judgment-engine endpoint, but the supervisor only needs
 * a process and a loopback socket. Everything asserted here is produced by the
 * production code path; this module supplies a fixture and reads the results,
 * it does not re-implement any of the containment.
 *
 * Four claims, each with an observation attached:
 *   1. teardown:  a stubborn grandchild that traps SIGTERM is still gone
 *                  afterwards (group-kill + SIGKILL escalation), 0 orphans.
 *   2. env:       the child receives the allowlist, not the runner's secrets.
 *   3. resources: the rlimits the child actually runs under (Linux; the
 *                  `ulimit` prologue is a documented no-op elsewhere).
 *   4. redirect:  a preview that 302s off loopback is refused, not followed.
 *
 * Pure formatting lives in `formatSupervisorDemoReport` so the CLI is a shell.
 */
const execFileAsync = promisify(execFile);

/** Grace window between SIGTERM and SIGKILL; shorter than production's 5s to keep the demo brisk. */
const DEFAULT_GRACE_MS = 2_000;

const FIXTURE_APP = fileURLToPath(new URL("../fixtures/preview-app.mjs", import.meta.url));

/** Runner secrets deliberately offered to the supervisor, to prove they do not reach the child. */
export const DEMO_RUNNER_SECRETS: Record<string, string> = {
  GITHUB_TOKEN: "ghp_demo_not_a_real_token",
  GATE_ENGINE_API_KEY: "sk_demo_not_a_real_key",
  GATE_ENGINE_HMAC_SECRET: "hmac_demo_not_a_real_secret",
};

export interface ProcessInfo {
  pid: number;
  pgid: number;
  /** Single-letter process state (`R`, `S`, `Z`, …); empty when the source did not report one. */
  state: string;
  command: string;
  /** A reaped-but-unwaited process: still a pid, but no longer running anything. */
  zombie: boolean;
}

/** One observation of the child's process group while teardown is in flight. */
export interface CensusSample {
  atMs: number;
  alive: boolean;
  processes: ProcessInfo[] | null;
}

export interface ChildLimits {
  maxUserProcesses: { soft: number | string; hard: number | string } | null;
  virtualMemoryBytes: { soft: number | string; hard: number | string } | null;
}

export interface TeardownScenario {
  ok: boolean;
  url: string;
  pid: number;
  readyMs: number;
  pageStatus: number;
  pageTitle: string;
  buildFacts: PreviewBuildFact[];
  childEnvKeys: string[];
  leakedSecrets: string[];
  childLimits: ChildLimits | null;
  groupBeforeStop: ProcessInfo[] | null;
  census: CensusSample[];
  stopMs: number;
  orphanedGroup: boolean;
  /** Zombies left in the group: killed, but with no init around to reap them. */
  unreaped: ProcessInfo[];
  failure?: string;
}

export interface RedirectScenario {
  ok: boolean;
  refusedReason: string;
  detail: string;
  orphanedGroup: boolean;
}

export interface SupervisorDemoReport {
  platform: NodeJS.Platform;
  nodeVersion: string;
  shell: string;
  /** Grace window between SIGTERM and SIGKILL used for this run. */
  graceMs: number;
  limits: ResourceLimits;
  command: string;
  spawnedCommand: string;
  linuxCommand: string;
  capApplied: boolean;
  processTableAvailable: boolean;
  /** Env keys the allowlist let through to the child (`PORT` is added by the caller). */
  allowlistedEnvKeys: string[];
  teardown: TeardownScenario;
  redirect: RedirectScenario;
  ok: boolean;
}

export interface SupervisorDemoOptions {
  /** Grace between SIGTERM and SIGKILL; short so the demo stays quick. */
  graceMs?: number;
  /** Readiness ceiling for the fixture app. */
  ceilingMs?: number;
  resourceLimits?: ResourceLimits;
  /** Source env the allowlist is applied to; defaults to this process's env plus fake secrets. */
  sourceEnv?: NodeJS.ProcessEnv;
}

/** Parse `ps -A -o pid=,pgid=,state=,command=` into the rows belonging to one process group. */
export function parseProcessTable(text: string, pgid: number): ProcessInfo[] {
  const rows: ProcessInfo[] = [];
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const [, pid, group, state = "", command] = match;
    if (Number(group) !== pgid) continue;
    rows.push({
      pid: Number(pid),
      pgid: Number(group),
      state,
      command: (command ?? "").trim(),
      zombie: state.startsWith("Z"),
    });
  }
  return rows;
}

/**
 * Parse one `/proc/<pid>/stat` line: `pid (comm) state ppid pgrp …`. `comm` can
 * contain spaces and parentheses, so it is cut at the LAST `)`.
 */
export function parseProcStat(line: string): ProcessInfo | null {
  const close = line.lastIndexOf(")");
  const open = line.indexOf("(");
  if (open < 0 || close < open) return null;
  const pid = Number(line.slice(0, open).trim());
  const command = line.slice(open + 1, close);
  const rest = line.slice(close + 1).trim().split(/\s+/);
  const state = rest[0] ?? "";
  const pgid = Number(rest[3]); // ppid, pgrp are fields 4 and 5 (1-indexed)
  if (!Number.isFinite(pid) || !Number.isFinite(pgid)) return null;
  return { pid, pgid, state, command, zombie: state === "Z" };
}

/** Census from `/proc`, for Linux images that ship no `ps` (node:*-slim). */
async function censusViaProcFs(pgid: number): Promise<ProcessInfo[] | null> {
  let entries: string[];
  try {
    entries = await readdir("/proc");
  } catch {
    return null;
  }
  const rows: ProcessInfo[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const info = parseProcStat(await readFile(`/proc/${entry}/stat`, "utf8"));
      if (!info || info.pgid !== pgid) continue;
      // `comm` is the thread name ("MainThread" for node); the full argv is in
      // cmdline and is what a reader recognises. Zombies have an empty cmdline.
      const argv = (await readFile(`/proc/${entry}/cmdline`, "utf8")).split("\0").filter(Boolean);
      rows.push(argv.length > 0 ? { ...info, command: argv.join(" ") } : info);
    } catch {
      /* the process exited while we were reading it */
    }
  }
  return rows;
}

/** Group members that are actually running. A zombie holds a pid but runs nothing. */
export function liveProcesses(census: ProcessInfo[] | null): ProcessInfo[] {
  return (census ?? []).filter((p) => !p.zombie);
}

/**
 * Best-effort census of a process group: `ps` first, then `/proc` for minimal
 * Linux images that ship no `ps` (node:*-slim). A null census means "not
 * observable here", never "empty": the fallback liveness signal is
 * `kill(-pgid, 0)`, which always works but cannot see that a survivor is a
 * zombie.
 */
export async function censusProcessGroup(pgid: number): Promise<ProcessInfo[] | null> {
  try {
    const { stdout } = await execFileAsync("ps", ["-A", "-o", "pid=,pgid=,state=,command="]);
    return parseProcessTable(stdout, pgid);
  } catch {
    return censusViaProcFs(pgid);
  }
}

export function isGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Which allowlisted keys are absent from the child, i.e. secrets that did not leak. */
function leakedSecretsIn(childEnvKeys: string[], secrets: Record<string, string>): string[] {
  return Object.keys(secrets).filter((key) => childEnvKeys.includes(key));
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3_000) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function runTeardownScenario(
  options: SupervisorDemoOptions,
  env: Record<string, string>,
): Promise<TeardownScenario> {
  const empty: TeardownScenario = {
    ok: false,
    url: "",
    pid: 0,
    readyMs: 0,
    pageStatus: 0,
    pageTitle: "",
    buildFacts: [],
    childEnvKeys: [],
    leakedSecrets: [],
    childLimits: null,
    groupBeforeStop: null,
    census: [],
    stopMs: 0,
    orphanedGroup: false,
    unreaped: [],
  };

  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const startedAt = Date.now();
  const started = await startLocalServer(`node ${JSON.stringify(FIXTURE_APP)} serve`, {
    url,
    cwd: process.cwd(),
    env: { ...env, PORT: String(port) },
    resourceLimits: options.resourceLimits ?? DEFAULT_RESOURCE_LIMITS,
    ceilingMs: options.ceilingMs ?? 20_000,
    graceMs: options.graceMs ?? DEFAULT_GRACE_MS,
    pollIntervalMs: 100,
  });
  if (!started.ok) {
    return { ...empty, url, failure: `${started.reason}: ${started.detail}` };
  }
  const readyMs = Date.now() - startedAt;
  const server = started.server;

  const page = await fetch(url, { signal: AbortSignal.timeout(3_000) });
  const html = await page.text();
  const childEnvKeys = (await fetchJson<string[]>(`${url}/env`)) ?? [];
  const childLimits = await fetchJson<ChildLimits>(`${url}/limits`);
  const groupBeforeStop = await censusProcessGroup(server.pid);

  // Sample the group WHILE stop() runs: the stubborn worker survives SIGTERM, so
  // the census steps down twice, once on SIGTERM and once on the SIGKILL escalation.
  const census: CensusSample[] = [{ atMs: 0, alive: true, processes: groupBeforeStop }];
  const stopStartedAt = Date.now();
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  // The sampler is bounded twice over: it stops when the group is gone, and it
  // stops when teardown has finished plus a margin. Without the second bound it
  // would spin forever wherever a killed process stays a zombie: a container
  // whose PID 1 is this process reaps nothing, and `kill(-pgid, 0)` still
  // succeeds for a zombie.
  let stopFinished = false;
  const samplerDeadline = stopStartedAt + graceMs + 5_000;
  const sampling = (async () => {
    for (;;) {
      await sleep(50);
      const atMs = Date.now() - stopStartedAt;
      const alive = isGroupAlive(server.pid);
      const processes = alive ? await censusProcessGroup(server.pid) : [];
      census.push({ atMs, alive, processes });
      if (!alive) return;
      if (processes !== null && liveProcesses(processes).length === 0) return; // only zombies left
      if (stopFinished && Date.now() > samplerDeadline) return;
    }
  })();
  await server.stop();
  stopFinished = true;
  await sampling;
  const stopMs = Date.now() - stopStartedAt;

  const buildFacts = parsePreviewBuildFacts(server.output());
  const leakedSecrets = leakedSecretsIn(childEnvKeys, DEMO_RUNNER_SECRETS);
  // An orphan is a process still RUNNING in the group. A zombie is not an
  // orphan: it holds a pid until someone reaps it but executes nothing.
  const finalCensus = isGroupAlive(server.pid) ? await censusProcessGroup(server.pid) : [];
  const unreaped = (finalCensus ?? []).filter((p) => p.zombie);
  const orphanedGroup = finalCensus === null ? isGroupAlive(server.pid) : liveProcesses(finalCensus).length > 0;

  return {
    ok:
      page.status === 200 &&
      !orphanedGroup &&
      leakedSecrets.length === 0 &&
      buildFacts.length > 0 &&
      childEnvKeys.length > 0,
    url,
    pid: server.pid,
    readyMs,
    pageStatus: page.status,
    pageTitle: /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? "",
    buildFacts,
    childEnvKeys,
    leakedSecrets,
    childLimits,
    groupBeforeStop,
    census,
    stopMs,
    orphanedGroup,
    unreaped,
  };
}

async function runRedirectScenario(
  options: SupervisorDemoOptions,
  env: Record<string, string>,
): Promise<RedirectScenario> {
  const port = await freePort();
  const started = await startLocalServer(`node ${JSON.stringify(FIXTURE_APP)} redirect`, {
    url: `http://127.0.0.1:${port}`,
    cwd: process.cwd(),
    env: { ...env, PORT: String(port) },
    resourceLimits: options.resourceLimits ?? DEFAULT_RESOURCE_LIMITS,
    ceilingMs: options.ceilingMs ?? 20_000,
    graceMs: options.graceMs ?? DEFAULT_GRACE_MS,
    pollIntervalMs: 100,
  });
  if (started.ok) {
    // The guard failed: the redirect was accepted. Clean up and report it.
    const pid = started.server.pid;
    await started.server.stop();
    return { ok: false, refusedReason: "accepted", detail: "the off-loopback redirect was not refused", orphanedGroup: isGroupAlive(pid) };
  }
  return {
    ok: started.reason === "redirected_off_loopback",
    refusedReason: started.reason,
    detail: started.detail,
    orphanedGroup: false,
  };
}

export async function runSupervisorDemo(options: SupervisorDemoOptions = {}): Promise<SupervisorDemoReport> {
  const limits = options.resourceLimits ?? DEFAULT_RESOURCE_LIMITS;
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  const sourceEnv = options.sourceEnv ?? { ...process.env, ...DEMO_RUNNER_SECRETS };
  const env = buildAllowlistedEnv(sourceEnv);
  const command = `node ${JSON.stringify(FIXTURE_APP)} serve`;

  const teardown = await runTeardownScenario(options, env);
  const redirect = await runRedirectScenario(options, env);
  const shell = resolveCapShell();

  return {
    platform: process.platform,
    nodeVersion: process.version,
    shell: shell === true ? "/bin/sh (platform default)" : shell,
    graceMs,
    limits,
    command,
    spawnedCommand: buildResourceCappedCommand(command, limits),
    linuxCommand: buildResourceCappedCommand(command, limits, "linux"),
    capApplied: process.platform === "linux",
    processTableAvailable: teardown.groupBeforeStop !== null,
    allowlistedEnvKeys: Object.keys(env).sort(),
    teardown,
    redirect,
    ok: teardown.ok && redirect.ok,
  };
}

function shorten(command: string, max = 88): string {
  const collapsed = command.split(process.execPath).join("node").split(process.cwd()).join(".");
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

/**
 * Keep only the samples where the group's size changed, plus the last one. The
 * teardown story is two transitions (SIGTERM, then the SIGKILL escalation);
 * every identical sample in between is noise.
 */
export function compressCensus(samples: CensusSample[]): CensusSample[] {
  const kept: CensusSample[] = [];
  let previous: number | null = null;
  for (const sample of samples) {
    const size = sample.alive ? (sample.processes === null ? -1 : liveProcesses(sample.processes).length) : 0;
    if (size !== previous) kept.push(sample);
    previous = size;
  }
  const last = samples.at(-1);
  if (last && kept.at(-1) !== last) kept.push(last);
  return kept;
}

function formatLimit(limit: { soft: number | string; hard: number | string } | null): string {
  if (!limit) return "unavailable";
  return `soft ${limit.soft}, hard ${limit.hard}`;
}

/** Render a report as the demo transcript. Pure; the CLI only prints the result. */
export function formatSupervisorDemoReport(report: SupervisorDemoReport): string {
  const out: string[] = [];
  const line = (s = ""): number => out.push(s);

  line("Gate sandbox supervisor demo");
  line(`platform ${report.platform} · node ${report.nodeVersion} · shell ${report.shell}`);
  line();

  line("[1/4] supervised start and process-group teardown");
  const t = report.teardown;
  if (t.failure) {
    line(`  FAILED  the fixture app never became ready: ${t.failure}`);
  } else {
    line(`  command       ${shorten(report.command)}`);
    line(`  ready         ${t.url} in ${t.readyMs} ms (pid ${t.pid}, process group ${t.pid})`);
    line(`  GET /         ${t.pageStatus} · ${t.pageTitle}`);
    line(`  build facts   ${t.buildFacts.length} parsed from the dev-server log`);
    for (const fact of t.buildFacts) line(`                ${fact.kind}: ${shorten(fact.message, 70)}`);
    if (t.groupBeforeStop) {
      line(`  process group ${t.groupBeforeStop.length} processes before stop()`);
      for (const p of t.groupBeforeStop) line(`                ${String(p.pid).padStart(7)}  ${shorten(p.command)}`);
    } else {
      line("  process group not listable here (no `ps`); liveness read with kill(-pgid, 0)");
    }
    line(`  stop()        SIGTERM to the group → ${report.graceMs} ms grace → SIGKILL to whatever survived`);
    for (const sample of compressCensus(t.census)) {
      const survivors = sample.processes;
      const running = survivors === null ? null : liveProcesses(survivors);
      const count = running === null ? "?" : String(running.length);
      const names = running?.map((p) => shorten(p.command.split("/").pop() ?? p.command, 44)) ?? [];
      const zombies = survivors === null ? 0 : survivors.length - (running?.length ?? 0);
      const who = names.length > 0 ? `  (${names.join("; ")})` : "";
      const z = zombies > 0 ? `  +${zombies} zombie` : "";
      line(`                +${String(sample.atMs).padStart(5)} ms  ${count} left${who}${z}`);
    }
    line(`  result        group gone after ${t.stopMs} ms · orphans: ${t.orphanedGroup ? "YES" : "0"}`);
    if (t.unreaped.length > 0) {
      line(`                ${t.unreaped.length} zombie pid(s) await reaping — this process is PID 1 here and reaps nothing;`);
      line("                a CI runner's init does. They run no code.");
    }
  }
  line();

  line("[2/4] environment allowlist");
  line(`  offered       ${Object.keys(DEMO_RUNNER_SECRETS).join(", ")} (fake runner secrets)`);
  line(`  passed in     ${report.allowlistedEnvKeys.join(", ") || "(nothing)"}`);
  line(`  child saw     ${t.childEnvKeys.join(", ") || "(nothing)"}  (PORT comes from the supervisor caller, PWD/SHLVL/_ from the shell)`);
  line(`  leaked        ${t.leakedSecrets.length === 0 ? "none" : t.leakedSecrets.join(", ")}`);
  line();

  line("[3/4] resource cap");
  line(`  limits        ${report.limits.maxProcesses} processes, ${report.limits.maxMemoryMb} MiB address space`);
  line(`  spawned as    ${shorten(report.spawnedCommand, 110)}`);
  if (!report.capApplied) {
    line(`  applied       no — the ulimit prologue is Linux-only, this is ${report.platform}`);
    line(`  on Linux      ${shorten(report.linuxCommand, 110)}`);
  } else {
    line("  applied       yes");
  }
  line(`  child reports max processes:   ${formatLimit(report.teardown.childLimits?.maxUserProcesses ?? null)}`);
  line(`                address space:  ${formatLimit(report.teardown.childLimits?.virtualMemoryBytes ?? null)}`);
  line();

  line("[4/4] off-loopback redirect refused");
  line(`  fixture       302 → https://preview.attacker.example/pwn`);
  line(`  supervisor    ${report.redirect.refusedReason}: ${report.redirect.detail}`);
  line();

  line(
    report.ok
      ? "PASS — fixture app served, contained, and torn down with no orphaned processes."
      : "FAIL — see the scenario output above.",
  );
  return out.join("\n");
}
