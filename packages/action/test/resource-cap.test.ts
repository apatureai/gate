import { describe, expect, it } from "vitest";
import { buildResourceCappedCommand, DEFAULT_RESOURCE_LIMITS, resolveCapShell } from "../src/index.js";

describe("buildResourceCappedCommand (#79)", () => {
  it("prepends a hard pids + memory ulimit prologue on Linux", () => {
    const out = buildResourceCappedCommand("npm run dev", { maxProcesses: 256, maxMemoryMb: 2048 }, "linux");
    expect(out).toBe("ulimit -u 256 2>/dev/null; ulimit -v 2097152 2>/dev/null; npm run dev");
  });

  it("converts the memory cap from MiB to the KiB ulimit -v expects", () => {
    const out = buildResourceCappedCommand("x", { maxProcesses: 1, maxMemoryMb: 1 }, "linux");
    expect(out).toContain("ulimit -v 1024 "); // 1 MiB = 1024 KiB
  });

  it("uses a hard cap (no -S) so hostile child code can't raise it back", () => {
    const out = buildResourceCappedCommand("x", DEFAULT_RESOURCE_LIMITS, "linux");
    expect(out).not.toContain("ulimit -S");
    expect(out).toContain(`ulimit -u ${DEFAULT_RESOURCE_LIMITS.maxProcesses}`);
  });

  it("is a no-op on non-Linux platforms (ulimit -v doesn't apply)", () => {
    expect(buildResourceCappedCommand("npm run dev", DEFAULT_RESOURCE_LIMITS, "darwin")).toBe("npm run dev");
    expect(buildResourceCappedCommand("npm run dev", DEFAULT_RESOURCE_LIMITS, "win32")).toBe("npm run dev");
  });

  it("tolerates a ulimit failure so the command still runs (2>/dev/null + ;)", () => {
    const out = buildResourceCappedCommand("serve", DEFAULT_RESOURCE_LIMITS, "linux");
    expect(out).toMatch(/2>\/dev\/null; .*2>\/dev\/null; serve$/);
  });

  it("floors fractional limits to integers", () => {
    const out = buildResourceCappedCommand("x", { maxProcesses: 10.9, maxMemoryMb: 2.5 }, "linux");
    expect(out).toContain("ulimit -u 10 ");
    expect(out).toContain("ulimit -v 2048 "); // floor(2.5)=2 MiB -> 2048 KiB
  });
});

describe("resolveCapShell (#79)", () => {
  it("runs the capped command under bash on Linux, where /bin/sh is dash", () => {
    // dash's `ulimit` has no `-u`, so the pids cap would be silently dropped.
    expect(resolveCapShell("linux", (p) => p === "/bin/bash")).toBe("/bin/bash");
  });

  it("falls back to the default shell when bash is missing (memory cap still applies)", () => {
    expect(resolveCapShell("linux", () => false)).toBe(true);
  });

  it("uses the default shell off Linux, where the prologue is a no-op anyway", () => {
    expect(resolveCapShell("darwin", () => true)).toBe(true);
    expect(resolveCapShell("win32", () => true)).toBe(true);
  });
});
