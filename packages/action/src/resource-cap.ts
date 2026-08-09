import { existsSync } from "node:fs";

/**
 * Resource cap for the local-serve child (#79). The #70 supervisor contains the
 * fork dev-server for CONFIDENTIALITY (env allowlist + loopback-only + ephemeral
 * runner) and bounds TIME (the readiness ceiling), but not resource USE: a fork
 * fork-bomb, memory balloon, or runaway can wedge the runner before teardown.
 *
 * This caps pids + memory on the spawned process group. Two mechanisms, by
 * availability:
 *   - **`ulimit` prologue (implemented here):** the supervisor spawns with
 *     `{ shell: true }`, so we prepend `ulimit` to the shell command; the limits
 *     are inherited by every process the dev server forks. Portable, no host
 *     privileges. Linux-only — `ulimit -v` (RLIMIT_AS) is unsupported/ineffective
 *     on macOS/Windows, so on those we leave the command unchanged (the runner is
 *     Linux in production; local dev just runs without the cap).
 *   - **cgroup v2 (deferred, ops):** a per-job cgroup with `pids.max` +
 *     `memory.max` is stricter (aggregate, not per-process) but needs host setup
 *     (systemd-run / cgroup fs write) — left to the live runner image.
 *
 * Pure command construction; fully unit-testable. The kernel does the enforcing.
 */

export interface ResourceLimits {
  /** Max processes (RLIMIT_NPROC / `ulimit -u`) — the fork-bomb guard. */
  maxProcesses: number;
  /** Max address space per process in MiB (RLIMIT_AS / `ulimit -v`) — the balloon guard. */
  maxMemoryMb: number;
}

/**
 * Defaults: generous enough for a real dev server / build, tight enough to keep
 * a runaway from wedging an ephemeral runner. Tunable via StartLocalServerOptions.
 */
export const DEFAULT_RESOURCE_LIMITS: ResourceLimits = {
  maxProcesses: 512,
  maxMemoryMb: 4096,
};

/**
 * Wrap a shell command with a `ulimit` prologue that hard-caps pids + memory for
 * the command and everything it forks. Returns the command UNCHANGED on
 * non-Linux platforms (where `ulimit -v` doesn't apply). The hard cap (no `-S`)
 * means hostile child code can't raise it back up. `ulimit` failures are
 * tolerated (`;`) so the command still runs if a limit can't be set.
 */
export function buildResourceCappedCommand(
  command: string,
  limits: ResourceLimits = DEFAULT_RESOURCE_LIMITS,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== "linux") return command;
  const kb = Math.max(1, Math.floor(limits.maxMemoryMb)) * 1024;
  const procs = Math.max(1, Math.floor(limits.maxProcesses));
  // Set processes + virtual-memory caps (hard+soft), then run the command in the
  // same limited shell so all descendants inherit the rlimits.
  return `ulimit -u ${procs} 2>/dev/null; ulimit -v ${kb} 2>/dev/null; ${command}`;
}

/**
 * Shell the capped command must run in. `{ shell: true }` gives `/bin/sh`, which
 * on Debian/Ubuntu (every ubuntu-latest runner) is dash — and dash's `ulimit`
 * has no `-u`, so the pids cap silently does nothing there while `-v` still
 * applies. Selecting bash when it exists is what makes `ulimit -u` real; if bash
 * is missing we fall back to Node's default shell and keep the memory cap.
 *
 * Returns what `child_process.spawn`'s `shell` option takes: a path, or `true`
 * for the platform default.
 */
export function resolveCapShell(
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = defaultExists,
): string | true {
  if (platform !== "linux") return true;
  return exists(BASH_PATH) ? BASH_PATH : true;
}

const BASH_PATH = "/bin/bash";

function defaultExists(path: string): boolean {
  return existsSync(path);
}
