import { loadGoldenReviewResult } from "@gate/types";
import { describe, expect, it } from "vitest";
import { buildCheckRun, mapCheckRunConclusion } from "../src/index.js";

describe("mapCheckRunConclusion", () => {
  it("maps ship and ship_with_nits to success", () => {
    expect(mapCheckRunConclusion("ship", "none")).toBe("success");
    expect(mapCheckRunConclusion("ship_with_nits", "blockers")).toBe("success");
  });

  it("maps needs_work to neutral", () => {
    expect(mapCheckRunConclusion("needs_work", "none")).toBe("neutral");
    expect(mapCheckRunConclusion("needs_work", "blockers")).toBe("neutral");
  });

  it("fails on blocked only when gate:blockers is opted in", () => {
    expect(mapCheckRunConclusion("blocked", "blockers")).toBe("failure");
    expect(mapCheckRunConclusion("blocked", "none")).toBe("neutral");
    expect(mapCheckRunConclusion("blocked", "nits")).toBe("neutral");
  });

  it("is never-blocking by default (no failure unless blockers)", () => {
    const grades = ["ship", "ship_with_nits", "needs_work", "blocked"] as const;
    for (const g of grades) {
      expect(mapCheckRunConclusion(g, "none")).not.toBe("failure");
    }
  });
});

describe("buildCheckRun", () => {
  const result = loadGoldenReviewResult();

  it("includes summary, grade, and a details link (TRD §7)", () => {
    const run = buildCheckRun(result, "none", { detailsUrl: "https://gate.app/r/1" });
    expect(run.name).toBe("Apature Gate");
    expect(run.conclusion).toBe("neutral"); // golden grade is needs_work
    expect(run.summary).toContain("Grade:");
    expect(run.summary).toContain(result.overall);
    expect(run.summary).toContain("https://gate.app/r/1");
  });
});
