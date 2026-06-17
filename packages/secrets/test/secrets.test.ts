import { describe, expect, it } from "vitest";
import {
  APP_SECRET_KEYS,
  EnvSecretStore,
  LocalKms,
  openSecret,
  REDACTED,
  redact,
  sealSecret,
  storageStateForPr,
  assertStorageStateAllowed,
} from "../src/index.js";

const kms = LocalKms.fromPassphrase("test-root-passphrase-1234567890");

describe("envelope encryption", () => {
  it("round-trips a per-repo secret under a tenant CMK", async () => {
    const sealed = await sealSecret("vercel-bypass-token-abc", "tenant:acme", kms);
    expect(sealed.ciphertext).not.toContain("vercel-bypass-token-abc");
    expect(await openSecret(sealed, kms)).toBe("vercel-bypass-token-abc");
  });

  it("fails to open when the ciphertext is tampered (GCM integrity)", async () => {
    const sealed = await sealSecret("storage-state-blob", "tenant:acme", kms);
    const tampered = { ...sealed, ciphertext: Buffer.from("not-the-real-bytes").toString("base64") };
    await expect(openSecret(tampered, kms)).rejects.toThrow();
  });

  it("fails to open under the wrong CMK", async () => {
    const sealed = await sealSecret("secret", "tenant:acme", kms);
    await expect(openSecret({ ...sealed, keyId: "tenant:other" }, kms)).rejects.toThrow();
  });
});

describe("EnvSecretStore", () => {
  it("resolves all app secret keys from env", async () => {
    const store = new EnvSecretStore({
      GITHUB_APP_PRIVATE_KEY: "pk",
      GITHUB_WEBHOOK_SECRET: "ws",
      JUDGMENT_ENGINE_API_KEY: "ek",
      JUDGMENT_ENGINE_HMAC_SECRET: "hmac",
      STRIPE_SECRET_KEY: "sk",
      STRIPE_WEBHOOK_SECRET: "swh",
      JUDGMENT_ENGINE_ENDPOINT: "https://engine.acme.internal",
    });
    for (const key of APP_SECRET_KEYS) {
      await expect(store.get(key)).resolves.toBeTruthy();
    }
  });

  it("throws on a missing secret", async () => {
    const store = new EnvSecretStore({});
    await expect(store.get("webhookSecret")).rejects.toThrow(/Missing secret/);
  });
});

describe("redact", () => {
  it("masks sensitive keys and leaves the rest intact", () => {
    const out = redact({
      installationId: "inst_1",
      githubAppPrivateKey: "-----BEGIN KEY-----",
      nested: { engineApiKey: "ek_live", route: "/pricing" },
      protection_bypass: "tok",
    }) as Record<string, unknown>;
    expect(out.installationId).toBe("inst_1");
    expect(out.githubAppPrivateKey).toBe(REDACTED);
    expect((out.nested as Record<string, unknown>).engineApiKey).toBe(REDACTED);
    expect((out.nested as Record<string, unknown>).route).toBe("/pricing");
    expect(out.protection_bypass).toBe(REDACTED);
  });

  it("masks signed URLs and screenshot data by shape", () => {
    const signed = "https://cdn.example.com/i/1.png?X-Amz-Signature=deadbeef&exp=1";
    expect(redact(signed)).toBe(REDACTED);
    expect(redact("data:image/png;base64,AAAA")).toBe(REDACTED);
    expect(redact("https://example.com/i/1.png")).toBe("https://example.com/i/1.png");
  });

  it("handles circular references", () => {
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    const out = redact(a) as Record<string, unknown>;
    expect(out.name).toBe("a");
    expect(out.self).toBe("[Circular]");
  });
});

describe("fork-PR storageState guard", () => {
  it("disables storageState on fork PRs", () => {
    expect(storageStateForPr("blob", { isFork: true })).toBeNull();
    expect(storageStateForPr("blob", { isFork: false })).toBe("blob");
  });

  it("asserts against fork use", () => {
    expect(() => assertStorageStateAllowed(true)).toThrow(/fork/);
    expect(() => assertStorageStateAllowed(false)).not.toThrow();
  });
});
