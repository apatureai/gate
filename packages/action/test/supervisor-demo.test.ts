import { beforeAll, describe, expect, it } from "vitest";
import {
  compressCensus,
  liveProcesses,
  parseProcStat,
  DEMO_RUNNER_SECRETS,
  formatSupervisorDemoReport,
  isGroupAlive,
  parseProcessTable,
  runSupervisorDemo,
  type CensusSample,
  type SupervisorDemoReport,
} from "../src/index.js";

/**
 * The demo is the only entry point a reader runs by hand, so it is covered like
 * production code: one real end-to-end run (fixture app, real process group,
 * real teardown — loopback only, no network, no credentials) plus unit tests for
 * the pure helpers it prints through.
 */
const sample = (atMs: number, alive: boolean, commands: string[]): CensusSample => ({
  atMs,
  alive,
  processes: commands.map((command, i) => ({ pid: 100 + i, pgid: 100, state: "S", command, zombie: false })),
});

describe("parseProcessTable", () => {
  const table = [
    "    1     1 S    /sbin/launchd",
    "  842   842 S    sh -c node preview-app.mjs serve",
    "  843   842 Z    node preview-worker.mjs stubborn",
    "  900   900 S    node something-else.mjs",
    "garbage line",
  ].join("\n");

  it("keeps only the rows in the requested process group", () => {
    const rows = parseProcessTable(table, 842);
    expect(rows.map((r) => r.pid)).toEqual([842, 843]);
    expect(rows[1]?.command).toBe("node preview-worker.mjs stubborn");
  });

  it("returns nothing for a group with no live processes", () => {
    expect(parseProcessTable(table, 999)).toEqual([]);
  });

  it("marks a Z-state row as a zombie, and liveProcesses drops it", () => {
    const rows = parseProcessTable(table, 842);
    expect(rows.map((r) => r.zombie)).toEqual([false, true]);
    expect(liveProcesses(rows).map((r) => r.pid)).toEqual([842]);
  });
});

describe("parseProcStat", () => {
  it("reads pid, state and process group from a /proc/<pid>/stat line", () => {
    const info = parseProcStat("843 (node) Z 1 842 842 0 -1 4194560 0 0 0 0 0 0 20 0 1 0 99 0 0");
    expect(info).toMatchObject({ pid: 843, pgid: 842, state: "Z", command: "node", zombie: true });
  });

  it("survives a comm containing spaces and parentheses", () => {
    const info = parseProcStat("12 (my (weird) proc) S 1 12 12 0 -1 0 0 0 0 0 0 0 20 0 1 0 5 0 0");
    expect(info).toMatchObject({ pid: 12, pgid: 12, command: "my (weird) proc", zombie: false });
  });

  it("returns null for a line it cannot parse", () => {
    expect(parseProcStat("not a stat line")).toBeNull();
  });
});

describe("compressCensus", () => {
  it("keeps only the transitions plus the final sample", () => {
    const samples = [
      sample(0, true, ["app", "worker-a", "worker-b"]),
      sample(100, true, ["worker-b"]),
      sample(200, true, ["worker-b"]),
      sample(300, true, ["worker-b"]),
      sample(2100, false, []),
    ];
    expect(compressCensus(samples).map((s) => s.atMs)).toEqual([0, 100, 2100]);
  });

  it("treats an unlistable process table as its own state, not as empty", () => {
    const unknown: CensusSample = { atMs: 0, alive: true, processes: null };
    const gone: CensusSample = { atMs: 50, alive: false, processes: [] };
    expect(compressCensus([unknown, gone]).map((s) => s.alive)).toEqual([true, false]);
  });
});

describe("runSupervisorDemo (real fixture app, real process group)", () => {
  let report: SupervisorDemoReport;

  beforeAll(async () => {
    report = await runSupervisorDemo({ graceMs: 1_000, ceilingMs: 20_000 });
  }, 60_000);

  it("serves the fixture app and reports the page it fetched", () => {
    expect(report.teardown.failure).toBeUndefined();
    expect(report.teardown.pageStatus).toBe(200);
    expect(report.teardown.pageTitle).toBe("Gate fixture preview app");
  });

  it("tears down the whole process group, including the worker that traps SIGTERM", () => {
    // The fixture forks two workers, so the group is a tree, not one process.
    if (report.teardown.groupBeforeStop) {
      expect(report.teardown.groupBeforeStop.length).toBeGreaterThanOrEqual(2);
    }
    expect(report.teardown.orphanedGroup).toBe(false);
    expect(isGroupAlive(report.teardown.pid)).toBe(false);
  });

  it("passes the child an allowlisted env, never the runner's secrets", () => {
    expect(report.teardown.childEnvKeys).toContain("PATH");
    expect(report.teardown.leakedSecrets).toEqual([]);
    for (const key of Object.keys(DEMO_RUNNER_SECRETS)) {
      expect(report.teardown.childEnvKeys).not.toContain(key);
    }
  });

  it("parses the fixture's dev-server log into grounded build facts", () => {
    expect(report.teardown.buildFacts.map((f) => f.kind)).toContain("hydration");
  });

  it("reports the rlimits the child actually ran under", () => {
    // Populated from the child's own diagnostic report; the ulimit prologue that
    // sets them is Linux-only, so only the observation is asserted here.
    expect(report.teardown.childLimits?.maxUserProcesses).toBeTruthy();
    expect(report.capApplied).toBe(process.platform === "linux");
    expect(report.linuxCommand).toContain("ulimit -u 512");
  });

  it("refuses a preview that redirects off loopback instead of following it", () => {
    expect(report.redirect.refusedReason).toBe("redirected_off_loopback");
    expect(report.redirect.detail).toContain("preview.attacker.example");
    expect(report.redirect.ok).toBe(true);
  });

  it("passes overall and renders a transcript ending in PASS", () => {
    expect(report.ok).toBe(true);
    const text = formatSupervisorDemoReport(report);
    expect(text).toContain("[1/4] supervised start and process-group teardown");
    expect(text).toContain("[4/4] off-loopback redirect refused");
    expect(text).toContain("orphans: 0");
    expect(text.trimEnd().endsWith("torn down with no orphaned processes.")).toBe(true);
  });
});

describe("formatSupervisorDemoReport", () => {
  const baseReport: SupervisorDemoReport = {
    platform: "linux",
    nodeVersion: "v24.14.0",
    shell: "/bin/bash",
    graceMs: 2_000,
    limits: { maxProcesses: 512, maxMemoryMb: 4096 },
    command: "node app.mjs",
    spawnedCommand: "ulimit -u 512 2>/dev/null; ulimit -v 4194304 2>/dev/null; node app.mjs",
    linuxCommand: "ulimit -u 512 2>/dev/null; ulimit -v 4194304 2>/dev/null; node app.mjs",
    capApplied: true,
    processTableAvailable: false,
    allowlistedEnvKeys: ["PATH"],
    teardown: {
      ok: false,
      url: "http://127.0.0.1:1",
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
      failure: "not_ready: no accepted response",
    },
    redirect: { ok: true, refusedReason: "redirected_off_loopback", detail: "refused", orphanedGroup: false },
    ok: false,
  };

  it("reports a failed run as FAIL rather than PASS", () => {
    const text = formatSupervisorDemoReport(baseReport);
    expect(text).toContain("FAILED  the fixture app never became ready: not_ready");
    expect(text).toContain("FAIL — see the scenario output above.");
  });

  it("says the process table was unlistable rather than pretending the group was empty", () => {
    const noPs: SupervisorDemoReport = {
      ...baseReport,
      teardown: { ...baseReport.teardown, ok: true, failure: undefined, groupBeforeStop: null },
    };
    const text = formatSupervisorDemoReport(noPs);
    expect(text).toContain("process group not listable here");
  });
});
