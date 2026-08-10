import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EnvSecretStore,
  legacySecretEnvVarName,
  resolveEngineClientEnv,
  resolveSecretEnv,
} from "../src/index.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("deprecated JUDGMENT_ENGINE_* names", () => {
  it("maps only the three engine-client keys", () => {
    expect(legacySecretEnvVarName("engineEndpoint")).toBe("JUDGMENT_ENGINE_ENDPOINT");
    expect(legacySecretEnvVarName("engineApiKey")).toBe("JUDGMENT_ENGINE_API_KEY");
    expect(legacySecretEnvVarName("engineHmacSecret")).toBe("JUDGMENT_ENGINE_HMAC_SECRET");
    expect(legacySecretEnvVarName("webhookSecret")).toBeNull();
    expect(legacySecretEnvVarName("githubAppPrivateKey")).toBeNull();
    expect(legacySecretEnvVarName("stripeSecretKey")).toBeNull();
  });

  it("reads the deprecated name and reports it", () => {
    expect(resolveSecretEnv("engineApiKey", { JUDGMENT_ENGINE_API_KEY: "old" })).toEqual({
      value: "old",
      legacyName: "JUDGMENT_ENGINE_API_KEY",
    });
  });

  it("prefers the canonical name and then reports no fallback", () => {
    const env = { GATE_ENGINE_API_KEY: "new", JUDGMENT_ENGINE_API_KEY: "old" };
    expect(resolveSecretEnv("engineApiKey", env)).toEqual({ value: "new", legacyName: null });
  });

  it("treats an empty canonical value as absent so the fallback still applies", () => {
    const env = { GATE_ENGINE_ENDPOINT: "", JUDGMENT_ENGINE_ENDPOINT: "https://old.internal" };
    expect(resolveSecretEnv("engineEndpoint", env)).toEqual({
      value: "https://old.internal",
      legacyName: "JUDGMENT_ENGINE_ENDPOINT",
    });
  });

  it("reports nothing when neither name is set", () => {
    expect(resolveSecretEnv("engineHmacSecret", {})).toEqual({ value: undefined, legacyName: null });
  });

  it("does not invent a fallback for keys that never had one", () => {
    expect(resolveSecretEnv("webhookSecret", { JUDGMENT_ENGINE_API_KEY: "old" })).toEqual({
      value: undefined,
      legacyName: null,
    });
  });
});

describe("resolveEngineClientEnv", () => {
  it("resolves all three from the canonical names with nothing to warn about", () => {
    expect(
      resolveEngineClientEnv({
        GATE_ENGINE_ENDPOINT: "https://engine.acme.internal",
        GATE_ENGINE_API_KEY: "ek",
        GATE_ENGINE_HMAC_SECRET: "hmac",
      }),
    ).toEqual({
      endpoint: "https://engine.acme.internal",
      apiKey: "ek",
      hmacSecret: "hmac",
      legacyNamesUsed: [],
    });
  });

  it("accepts a fully pre-rename environment and names every migration", () => {
    expect(
      resolveEngineClientEnv({
        JUDGMENT_ENGINE_ENDPOINT: "https://engine.acme.internal",
        JUDGMENT_ENGINE_API_KEY: "ek",
        JUDGMENT_ENGINE_HMAC_SECRET: "hmac",
      }),
    ).toEqual({
      endpoint: "https://engine.acme.internal",
      apiKey: "ek",
      hmacSecret: "hmac",
      legacyNamesUsed: [
        { legacyName: "JUDGMENT_ENGINE_ENDPOINT", canonicalName: "GATE_ENGINE_ENDPOINT" },
        { legacyName: "JUDGMENT_ENGINE_API_KEY", canonicalName: "GATE_ENGINE_API_KEY" },
        { legacyName: "JUDGMENT_ENGINE_HMAC_SECRET", canonicalName: "GATE_ENGINE_HMAC_SECRET" },
      ],
    });
  });

  it("reports a half-migrated environment one variable at a time", () => {
    const resolved = resolveEngineClientEnv({
      GATE_ENGINE_ENDPOINT: "https://engine.acme.internal",
      JUDGMENT_ENGINE_API_KEY: "ek",
    });
    expect(resolved.legacyNamesUsed).toEqual([
      { legacyName: "JUDGMENT_ENGINE_API_KEY", canonicalName: "GATE_ENGINE_API_KEY" },
    ]);
    expect(resolved.hmacSecret).toBeUndefined();
  });

  it("leaves the endpoint an empty string when unset, which is what yields a neutral Check Run", () => {
    expect(resolveEngineClientEnv({})).toEqual({
      endpoint: "",
      apiKey: undefined,
      hmacSecret: undefined,
      legacyNamesUsed: [],
    });
  });
});

describe("EnvSecretStore with deprecated names", () => {
  it("resolves through the fallback and warns once, without leaking the value", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = new EnvSecretStore({ JUDGMENT_ENGINE_HMAC_SECRET: "hmac-value" });
    await expect(store.get("engineHmacSecret")).resolves.toBe("hmac-value");
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain("JUDGMENT_ENGINE_HMAC_SECRET");
    expect(message).toContain("GATE_ENGINE_HMAC_SECRET");
    expect(message).not.toContain("hmac-value");
  });

  it("does not warn when the canonical name is used", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = new EnvSecretStore({ GATE_ENGINE_HMAC_SECRET: "hmac-value" });
    await expect(store.get("engineHmacSecret")).resolves.toBe("hmac-value");
    expect(warn).not.toHaveBeenCalled();
  });

  it("still reports the canonical name when a secret is missing entirely", async () => {
    const store = new EnvSecretStore({});
    await expect(store.get("engineApiKey")).rejects.toThrow(/GATE_ENGINE_API_KEY/);
  });
});
