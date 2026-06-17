import { describe, expect, it } from "vitest";
import {
  InstallationConcurrency,
  type PendingJob,
  selectNextJobs,
  tierConcurrency,
} from "../src/scheduling.js";

const jobs = (...specs: Array<[string, string]>): PendingJob[] =>
  specs.map(([installationId, key]) => ({ installationId, key }));

describe("tierConcurrency", () => {
  it("maps tiers to caps", () => {
    expect(tierConcurrency("free")).toBe(1);
    expect(tierConcurrency("team")).toBe(3);
    expect(tierConcurrency("enterprise")).toBe(10);
  });
});

describe("selectNextJobs fairness", () => {
  it("round-robins across installations so one hot installation can't starve others", () => {
    const pending = jobs(["A", "a#1"], ["A", "a#2"], ["A", "a#3"], ["B", "b#1"]);
    const selected = selectNextJobs(pending, { perInstallationCap: 5, maxToStart: 2 });
    // fair: one from A, one from B — not two from A
    expect(selected.map((j) => j.installationId)).toEqual(["A", "B"]);
  });

  it("respects the per-installation cap (in-flight + selected)", () => {
    const pending = jobs(["A", "a#1"], ["A", "a#2"], ["B", "b#1"]);
    const selected = selectNextJobs(pending, {
      perInstallationCap: 3,
      inFlightByInstallation: { A: 3 },
      maxToStart: 5,
    });
    expect(selected.map((j) => j.key)).toEqual(["b#1"]); // A is at cap
  });

  it("enforces (repo,pr)=1: skips a key already running and dedupes duplicates", () => {
    const pending = jobs(["A", "a#1"], ["A", "a#1"], ["A", "a#2"]);
    const selected = selectNextJobs(pending, {
      perInstallationCap: 5,
      inFlightKeys: ["a#2"],
      maxToStart: 5,
    });
    expect(selected.map((j) => j.key)).toEqual(["a#1"]); // a#1 once, a#2 already running
  });

  it("stops at maxToStart (global slots)", () => {
    const pending = jobs(["A", "a#1"], ["B", "b#1"], ["C", "c#1"]);
    expect(selectNextJobs(pending, { perInstallationCap: 5, maxToStart: 2 })).toHaveLength(2);
  });
});

describe("InstallationConcurrency", () => {
  it("caps in-flight per installation and releases slots", async () => {
    const c = new InstallationConcurrency(2);
    expect(await c.tryAcquire("inst")).toBe(true);
    expect(await c.tryAcquire("inst")).toBe(true);
    expect(await c.tryAcquire("inst")).toBe(false); // at cap
    expect(await c.inFlight("inst")).toBe(2);
    await c.release("inst");
    expect(await c.tryAcquire("inst")).toBe(true);
  });

  it("tracks installations independently", async () => {
    const c = new InstallationConcurrency(1);
    expect(await c.tryAcquire("a")).toBe(true);
    expect(await c.tryAcquire("b")).toBe(true);
    expect(await c.tryAcquire("a")).toBe(false);
  });
});
