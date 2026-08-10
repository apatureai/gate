import { APP_SECRET_ENV_VARS } from "@gate/secrets";
import { describe, expect, it } from "vitest";
import { PRODUCTION_ENV_VARS, assertProductionEnv, checkRequiredEnv } from "../src/index.js";

function fullEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(PRODUCTION_ENV_VARS.map((n) => [n, "set"]));
}

describe("production-readiness env check (#64)", () => {
  it("includes every app secret env var plus the infra URLs", () => {
    for (const v of APP_SECRET_ENV_VARS) expect(PRODUCTION_ENV_VARS).toContain(v);
    expect(PRODUCTION_ENV_VARS).toContain("GITHUB_APP_ID");
    expect(PRODUCTION_ENV_VARS).toContain("DATABASE_URL");
    expect(PRODUCTION_ENV_VARS).toContain("REDIS_URL");
    expect(PRODUCTION_ENV_VARS).toContain("GATE_SCREENSHOT_OBJECT_URL_TEMPLATE");
    expect(PRODUCTION_ENV_VARS).toContain("SCREENSHOT_CAPABILITY_SECRET");
    expect(PRODUCTION_ENV_VARS).toContain("FEEDBACK_TOKEN_SECRET");
  });

  it("reports ALL missing vars at once (not just the first)", () => {
    const env = fullEnv();
    delete env.DATABASE_URL;
    delete env.GITHUB_WEBHOOK_SECRET;
    const r = checkRequiredEnv(env);
    expect(r.ok).toBe(false);
    expect(r.missing.sort()).toEqual(["DATABASE_URL", "GITHUB_WEBHOOK_SECRET"].sort());
  });

  it("treats a blank/whitespace value as missing", () => {
    const env = fullEnv();
    env.REDIS_URL = "   ";
    expect(checkRequiredEnv(env).missing).toEqual(["REDIS_URL"]);
  });

  it("passes when every required var is present", () => {
    expect(checkRequiredEnv(fullEnv())).toEqual({ ok: true, missing: [] });
    expect(() => assertProductionEnv(fullEnv())).not.toThrow();
  });

  it("assertProductionEnv throws one aggregated error naming the missing vars + runbook", () => {
    const env = fullEnv();
    delete env.STRIPE_SECRET_KEY;
    delete env.REDIS_URL;
    expect(() => assertProductionEnv(env)).toThrow(/STRIPE_SECRET_KEY/);
    expect(() => assertProductionEnv(env)).toThrow(/REDIS_URL/);
    expect(() => assertProductionEnv(env)).toThrow(/go-live/);
  });

  it("honors a custom required set", () => {
    expect(checkRequiredEnv({ FOO: "x" }, ["FOO", "BAR"]).missing).toEqual(["BAR"]);
  });

  it("accepts a deprecated pre-rename alias, so the boot check agrees with EnvSecretStore", () => {
    const env = fullEnv();
    delete env.GATE_ENGINE_API_KEY;
    env.JUDGMENT_ENGINE_API_KEY = "set";
    expect(checkRequiredEnv(env)).toEqual({ ok: true, missing: [] });
    expect(() => assertProductionEnv(env)).not.toThrow();
  });

  it("still names the canonical variable when neither name is set", () => {
    const env = fullEnv();
    delete env.GATE_ENGINE_HMAC_SECRET;
    expect(checkRequiredEnv(env).missing).toEqual(["GATE_ENGINE_HMAC_SECRET"]);
  });

  it("treats a blank deprecated alias as missing too", () => {
    const env = fullEnv();
    delete env.GATE_ENGINE_ENDPOINT;
    env.JUDGMENT_ENGINE_ENDPOINT = "  ";
    expect(checkRequiredEnv(env).missing).toEqual(["GATE_ENGINE_ENDPOINT"]);
  });

  it("does not invent an alias for a variable that never had one", () => {
    const env = fullEnv();
    delete env.DATABASE_URL;
    env.JUDGMENT_ENGINE_ENDPOINT = "set";
    expect(checkRequiredEnv(env).missing).toEqual(["DATABASE_URL"]);
  });
});
