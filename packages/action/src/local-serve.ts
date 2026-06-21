import { spawn as nodeSpawn } from "node:child_process";
import { waitForReadiness } from "@gate/engine";
import { buildResourceCappedCommand, DEFAULT_RESOURCE_LIMITS, type ResourceLimits } from "./resource-cap.js";

/**
 * Local build-and-serve supervisor for the Action path (#70). Spawns the repo's
 * `preview-command`, waits for the local server to respond, and guarantees
 * teardown of the whole process tree. The hosted engine can't reach the runner's
 * localhost, so this runs in `@gate/action` on the GitHub runner.
 *
 * Implementation note (refines DR-9): built on `node:child_process` directly,
 * NOT execa. A dev server (`npm run dev`) forks children, so teardown MUST
 * group-kill the tree via `process.kill(-pgid, sig)` — execa's
 * `forceKillAfterDelay` only signals the direct child, and its `cleanup` is
 * covered by Part 5's process signal handlers + the tini PID-1 backstop. So
 * execa would be redundant here; the grace->SIGKILL escalation is ours. Linux
 * runner only (POSIX process groups); Windows is out of scope.
 *
 * Readiness reuses the shared `waitForReadiness` (#70 Part 1) for the ceiling +
 * early-exit race, with the Playwright `webServer` ready-status set (DR-10) and
 * the U2 hostile-redirect guard (probe `redirect:"manual"`; an off-loopback 3xx
 * Location is refused, not followed). Child env is the caller's allowlisted env
 * (`buildAllowlistedEnv`), never the runner's secrets.
 */
export type LocalServerReason = "spawn_failed" | "early_exit" | "not_ready" | "redirected_off_loopback";

export interface LocalServerHandle {
  url: string;
  pid: number;
  /** Captured stdout+stderr so far (bounded ring buffer) — the build/boot log (#70 U1). */
  output(): string;
  /** Terminate the process group (SIGTERM -> grace -> SIGKILL). Idempotent. */
  stop(): Promise<void>;
}

export type LocalServerStartResult =
  | { ok: true; server: LocalServerHandle }
  | { ok: false; reason: LocalServerReason; detail: string; tail?: string };

export interface StartLocalServerOptions {
  url: string;
  cwd: string;
  env: Record<string, string>;
  /** Poll this path (resolved against `url`) for readiness instead of the base URL (#80). */
  readyPath?: string | null;
  /** Accept only these status codes as ready (#80); null/empty → the default Playwright set. */
  readyStatus?: number[] | null;
  /** Resource cap (pids + memory) for the child group (#79); defaults to DEFAULT_RESOURCE_LIMITS. */
  resourceLimits?: ResourceLimits;
  ceilingMs?: number; // default 120_000
  graceMs?: number; // default 5_000
  pollIntervalMs?: number; // default 2_000
  probeTimeoutMs?: number; // per-probe timeout, default 3_000
  spawnImpl?: typeof nodeSpawn;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const MAX_TAIL_BYTES = 16_384;

/** Allowlisted child env (default-deny): never leak runner secrets to fork code. */
const ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "TERM",
  "CI",
  "NODE_ENV",
  "GITHUB_WORKSPACE",
  "RUNNER_OS",
  "RUNNER_TEMP",
] as const;

export function buildAllowlistedEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const v = source[key];
    if (typeof v === "string") env[key] = v;
  }
  return env;
}

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "::1" || host === "[::1]" || /^127(\.\d{1,3}){3}$/.test(host);
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Accepted readiness statuses: Playwright webServer's set (DR-10). 599 = synthetic "refused". */
function defaultAcceptStatus(status: number): boolean {
  if (status === 599) return false;
  return (status >= 200 && status <= 399) || status === 400 || status === 401 || status === 402 || status === 403;
}

/** Build the readiness acceptor: an explicit status set (#80) or the default Playwright set. */
function acceptStatusFor(readyStatus: number[] | null | undefined): (status: number) => boolean {
  if (readyStatus && readyStatus.length > 0) {
    const allowed = new Set(readyStatus);
    return (status: number) => status !== 599 && allowed.has(status);
  }
  return defaultAcceptStatus;
}

/** Resolve the readiness probe URL: `readyPath` against the base, else the base URL (#80). */
function resolveReadyUrl(baseUrl: string, readyPath: string | null | undefined): string {
  if (!readyPath) return baseUrl;
  try {
    return new URL(readyPath, baseUrl).toString();
  } catch {
    return baseUrl;
  }
}

export async function startLocalServer(
  command: string,
  options: StartLocalServerOptions,
): Promise<LocalServerStartResult> {
  const spawn = options.spawnImpl ?? nodeSpawn;
  const graceMs = options.graceMs ?? 5_000;
  const probeTimeoutMs = options.probeTimeoutMs ?? 3_000;
  const sleep = options.sleep ?? defaultSleep;

  // #79: cap pids + memory on the child group (Linux) so a fork-bomb / balloon
  // can't wedge the runner before teardown. No-op off Linux; the time ceiling +
  // env allowlist + loopback still apply.
  const cappedCommand = buildResourceCappedCommand(command, options.resourceLimits ?? DEFAULT_RESOURCE_LIMITS);
  const child = spawn(cappedCommand, {
    shell: true,
    detached: true, // own process group -> group-kill the tree on teardown
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Bounded ring buffer of child output (continuous drain so a chatty server
  // can't block on a full pipe). Logged on failure; never echoed to a PR.
  let tail = "";
  const append = (chunk: Buffer | string): void => {
    tail = (tail + chunk.toString()).slice(-MAX_TAIL_BYTES);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);

  let exited = false;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  let spawnErrorMessage: string | null = null;
  child.on("exit", (code, signal) => {
    exited = true;
    exitCode = code;
    exitSignal = signal;
  });
  child.on("error", (err: Error) => {
    spawnErrorMessage = err.message;
    exited = true;
  });

  const pid = child.pid;
  const killGroup = (signal: NodeJS.Signals): void => {
    if (pid === undefined) return;
    try {
      process.kill(-pid, signal); // negative pid = the whole process group
    } catch {
      /* ESRCH: already gone */
    }
  };
  const groupAlive = (): boolean => {
    if (pid === undefined) return false;
    try {
      process.kill(-pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    if (exited || pid === undefined) return;
    killGroup("SIGTERM");
    const start = (options.now ?? Date.now)();
    // Poll for clean exit up to graceMs, then SIGKILL the group if still alive.
    while (!exited && (options.now ?? Date.now)() - start < graceMs) {
      await sleep(Math.min(100, graceMs));
    }
    if (!exited && groupAlive()) killGroup("SIGKILL");
  };

  // U2 hostile-redirect guard: probe with redirect:"manual"; an off-loopback 3xx
  // Location is refused (synthetic 599 keeps the loop going) and surfaced after.
  let offLoopbackHost: string | null = null;
  const baseFetch = options.fetchImpl ?? fetch;
  const probeFetch = (async (input: string, init?: RequestInit) => {
    const signal = init?.signal ?? AbortSignal.timeout(probeTimeoutMs);
    const res = await baseFetch(input, { ...init, redirect: "manual", signal });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (loc) {
        try {
          const target = new URL(loc, options.url);
          if (!isLoopbackHost(target.hostname)) {
            offLoopbackHost = target.hostname;
            return new Response("", { status: 599 });
          }
        } catch {
          /* relative/odd Location -> treat as same-origin, let acceptStatus decide */
        }
      }
    }
    return res;
  }) as unknown as typeof fetch;

  const readyUrl = resolveReadyUrl(options.url, options.readyPath);
  const result = await waitForReadiness({
    url: readyUrl,
    acceptStatus: acceptStatusFor(options.readyStatus),
    abortOnChildExit: () => exited,
    ceilingMs: options.ceilingMs,
    pollIntervalMs: options.pollIntervalMs,
    fetchImpl: probeFetch,
    now: options.now,
    sleep,
  });

  if (result.ready && pid !== undefined && !exited) {
    return { ok: true, server: { url: options.url, pid, output: () => tail, stop } };
  }

  // Not ready: classify from the poll outcome BEFORE teardown — calling stop()
  // SIGTERMs a still-running server, which would otherwise look like early_exit.
  if (spawnErrorMessage) return { ok: false, reason: "spawn_failed", detail: spawnErrorMessage, tail };
  const childDiedOnItsOwn = !result.ready && result.reason === "child_exited";
  const exitDetail = `preview-command exited (code=${exitCode} signal=${exitSignal})`;
  await stop();
  if (offLoopbackHost) {
    return { ok: false, reason: "redirected_off_loopback", detail: `preview redirected to ${offLoopbackHost}`, tail };
  }
  if (childDiedOnItsOwn) {
    return { ok: false, reason: "early_exit", detail: exitDetail, tail };
  }
  return { ok: false, reason: "not_ready", detail: `no accepted response at ${readyUrl} within ${options.ceilingMs ?? 120_000}ms`, tail };
}
