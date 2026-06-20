import { describe, expect, it } from "vitest";
import {
  buildBeforeAfterArtifact,
  buildComparisonPairs,
  type CaptureRef,
  createInMemoryBaselineStore,
} from "../src/baseline.js";

const cap = (route: string, screenshotId: string, sha: string): CaptureRef => ({
  route,
  viewport: "desktop",
  screenshotId,
  sha,
});

describe("baseline store", () => {
  it("stores and retrieves the main-branch capture per route", async () => {
    const store = createInMemoryBaselineStore();
    await store.set("acme/web", cap("/pricing", "base1", "main1"));
    expect(await store.get("acme/web", "/pricing", "desktop")).toMatchObject({ screenshotId: "base1" });
    expect(await store.get("acme/web", "/missing", "desktop")).toBeNull();
    expect(await store.list("acme/web")).toHaveLength(1);
  });
});

describe("buildComparisonPairs", () => {
  it("pairs current captures with their baseline by route + viewport", () => {
    const baselines = [cap("/pricing", "base1", "main1")];
    const current = [cap("/pricing", "after1", "pr1"), cap("/new", "after2", "pr1")];
    const pairs = buildComparisonPairs(baselines, current);

    const pricing = pairs.find((p) => p.route === "/pricing");
    expect(pricing?.before?.screenshotId).toBe("base1");
    expect(pricing?.after.screenshotId).toBe("after1");

    const newRoute = pairs.find((p) => p.route === "/new");
    expect(newRoute?.before).toBeNull(); // route new in this PR
  });
});

describe("buildBeforeAfterArtifact", () => {
  it("emits a before/after pair with stable URLs", () => {
    const [pair] = buildComparisonPairs([cap("/pricing", "base1", "m")], [cap("/pricing", "after1", "p")]);
    const artifact = buildBeforeAfterArtifact(pair!, "https://gate.app/");
    expect(artifact).toEqual({
      route: "/pricing",
      viewport: "desktop",
      beforeUrl: "https://gate.app/i/base1.png",
      afterUrl: "https://gate.app/i/after1.png",
    });
  });

  it("has a null beforeUrl for a new route", () => {
    const [pair] = buildComparisonPairs([], [cap("/new", "after2", "p")]);
    expect(buildBeforeAfterArtifact(pair!, "https://gate.app").beforeUrl).toBeNull();
  });
});
