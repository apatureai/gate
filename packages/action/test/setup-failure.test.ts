import { ConfigValidationError, loadDesignReviewConfig } from "@gate/config";
import type { CheckRun } from "@gate/delivery";
import { describe, expect, it, vi } from "vitest";
import { publishSetupFailureCheckRun, setupFailureCheckRun } from "../src/setup-failure.js";

describe("setupFailureCheckRun", () => {
  it("turns YAML syntax errors into a neutral config Check Run", () => {
    let error: unknown;
    try {
      loadDesignReviewConfig("preview: [");
    } catch (err) {
      error = err;
    }

    const run = setupFailureCheckRun(error);
    expect(run).toMatchObject({
      name: "Apature Gate",
      conclusion: "neutral",
      title: "Config invalid",
    });
    expect(run.summary).toContain(".gate.yml");
    expect(run.summary).toContain("YAML syntax");
  });

  it("surfaces readable schema issues and caps the summary", () => {
    let error: unknown;
    try {
      loadDesignReviewConfig("preview:\n  source: github-pages\nunknown: true\n");
    } catch (err) {
      error = err;
    }

    const run = setupFailureCheckRun(error);
    expect(run.conclusion).toBe("neutral");
    expect(run.title).toBe("Config invalid");
    expect(run.summary).toContain("preview.source");
    expect(run.summary).toContain("(root)");
  });

  it("caps oversized config summaries", () => {
    const run = setupFailureCheckRun(new ConfigValidationError([`oversized: ${"x".repeat(3000)}`]));
    expect(run.summary.length).toBeLessThanOrEqual(1_800);
    expect(run.summary).toContain("[truncated]");
  });
});

describe("publishSetupFailureCheckRun", () => {
  it("publishes the neutral Check Run when the workflow is still current", async () => {
    const published: CheckRun[] = [];
    const result = await publishSetupFailureCheckRun(new Error("boom"), {
      headSha: "abc",
      getCurrentHeadSha: vi.fn(async () => "abc"),
      publishCheckRun: vi.fn(async (run) => void published.push(run)),
    });

    expect(result).toBe("published");
    expect(published[0]?.title).toBe("Action setup failed");
    expect(published[0]?.conclusion).toBe("neutral");
  });

  it("suppresses setup-failure Check Runs for stale workflow heads", async () => {
    const publishCheckRun = vi.fn(async () => {});
    const result = await publishSetupFailureCheckRun(new Error("boom"), {
      headSha: "abc",
      getCurrentHeadSha: vi.fn(async () => "newer"),
      publishCheckRun,
    });

    expect(result).toBe("stale");
    expect(publishCheckRun).not.toHaveBeenCalled();
  });
});
