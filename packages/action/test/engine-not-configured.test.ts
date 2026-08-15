import { engineNotConfiguredCheckRun } from "@gate/delivery";
import { describe, expect, it } from "vitest";
import { missingEngineSettings, resolveEngineClientEnv } from "@gate/secrets";

/**
 * The first-run state of every new installation: the workflow is added, no
 * engine is configured, and the question is whether that is obvious.
 *
 * Before this check, an unset endpoint reached `fetch("/jobs")`, whose
 * `TypeError: Failed to parse URL` was caught by the same handler as a real
 * outage and published as "temporarily unavailable ... Gate will retry" —
 * advice that can never come true, on every push, forever.
 */
describe("missingEngineSettings", () => {
  it("names both required settings when nothing is configured", () => {
    expect(missingEngineSettings(resolveEngineClientEnv({}))).toEqual([
      "GATE_ENGINE_ENDPOINT",
      "GATE_ENGINE_HMAC_SECRET",
    ]);
  });

  it("names the signing secret when only the endpoint is set", () => {
    // Every engine request is signed; verdict answers 401 to anything unsigned,
    // so an endpoint with no secret is a run that cannot submit.
    const env = resolveEngineClientEnv({ GATE_ENGINE_ENDPOINT: "http://127.0.0.1:8791" });
    expect(missingEngineSettings(env)).toEqual(["GATE_ENGINE_HMAC_SECRET"]);
  });

  it("treats an empty or whitespace value as missing, not as configured", () => {
    const env = resolveEngineClientEnv({ GATE_ENGINE_ENDPOINT: "   ", GATE_ENGINE_HMAC_SECRET: "" });
    expect(missingEngineSettings(env)).toEqual(["GATE_ENGINE_ENDPOINT", "GATE_ENGINE_HMAC_SECRET"]);
  });

  it("accepts a fully configured engine, API key or not", () => {
    const env = resolveEngineClientEnv({
      GATE_ENGINE_ENDPOINT: "http://127.0.0.1:8791",
      GATE_ENGINE_HMAC_SECRET: "s",
    });
    expect(missingEngineSettings(env)).toEqual([]);
  });

  it("accepts the deprecated names, so a rename is not read as a missing engine", () => {
    const env = resolveEngineClientEnv({
      JUDGMENT_ENGINE_ENDPOINT: "http://127.0.0.1:8791",
      JUDGMENT_ENGINE_HMAC_SECRET: "s",
    });
    expect(missingEngineSettings(env)).toEqual([]);
  });
});

describe("the Check Run an unconfigured install gets", () => {
  const run = engineNotConfiguredCheckRun(["GATE_ENGINE_ENDPOINT", "GATE_ENGINE_HMAC_SECRET"]);

  it("is neutral, and never reads as a pass", () => {
    expect(run.conclusion).toBe("neutral");
    expect(run.title).toBe("Engine not configured");
    expect(run.summary).toContain("This is not a pass.");
  });

  it("names the variables that are missing", () => {
    expect(run.summary).toContain("GATE_ENGINE_ENDPOINT");
    expect(run.summary).toContain("GATE_ENGINE_HMAC_SECRET");
  });

  it("points at an engine instead of promising a retry that cannot help", () => {
    expect(run.summary).toContain("apatureai/verdict");
    expect(run.summary).not.toContain("retry");
  });
});
