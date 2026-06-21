import { APP_SECRET_ENV_VARS } from "@gate/secrets";
import { describe, expect, it } from "vitest";
import { PRODUCTION_ENV_VARS, assertProductionEnv, checkRequiredEnv } from "../src/index.js";

function fullEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(PRODUCTION_ENV_VARS.map((n) => [n, "set"]));
}

describe("production-readiness env check (#64)", () => {
  it("includes every app secret env var plus the infra URLs", () => {
    for (const v of APP_SECRET_ENV_VARS) expect(PRODUCTION_ENV_VARS).toContain(v);
    expect(PRODUCTION_ENV_VARS).toContain("DATABASE_URL");
    expect(PRODUCTION_ENV_VARS).toContain("REDIS_URL");
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
});
