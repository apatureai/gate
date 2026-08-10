import { LocalKms, openSecret } from "@gate/secrets";
import { describe, expect, it } from "vitest";
import {
  buildOnboardingConfig,
  ONBOARDING_STEPS,
  PROVIDER_GUIDES,
  sealProtectionBypass,
} from "../src/onboarding.js";

describe("onboarding steps + provider guides", () => {
  it("asks for the brand block first", () => {
    expect(ONBOARDING_STEPS[0]?.key).toBe("brand");
    expect(ONBOARDING_STEPS[0]?.primary).toBe(true);
  });

  it("documents Netlify and Cloudflare equivalents", () => {
    expect(PROVIDER_GUIDES.vercel?.bypassSecretEnv).toBe("VERCEL_AUTOMATION_BYPASS_SECRET");
    expect(PROVIDER_GUIDES.netlify?.defaultEnvironment).toBe("Deploy Preview");
    expect(PROVIDER_GUIDES.cloudflare?.docs.toLowerCase()).toContain("pages.dev");
  });
});

describe("buildOnboardingConfig", () => {
  it("produces a valid .gate.yml from the answers", () => {
    const { yaml, validation } = buildOnboardingConfig({
      brand: "Calm fintech for SMB owners.",
      source: "vercel",
      protectionBypassSecretName: "VERCEL_AUTOMATION_BYPASS_SECRET",
    });
    expect(validation.ok).toBe(true);
    if (validation.ok) {
      expect(validation.config.brand).toContain("fintech");
      expect(validation.config.preview.source).toBe("vercel");
      expect(validation.config.preview.environment).toBe("Preview");
      expect(validation.config.preview.protectionBypassSecretName).toBe("VERCEL_AUTOMATION_BYPASS_SECRET");
    }
    expect(yaml).toContain("brand:");
  });

  it("defaults the environment per provider (Netlify -> Deploy Preview)", () => {
    const { validation } = buildOnboardingConfig({ brand: "b", source: "netlify" });
    if (validation.ok) expect(validation.config.preview.environment).toBe("Deploy Preview");
    else throw new Error("expected valid config");
  });
});

describe("sealProtectionBypass", () => {
  it("KMS-seals the bypass secret value", async () => {
    const kms = LocalKms.fromPassphrase("tenant-root-passphrase-1234567890");
    const sealed = await sealProtectionBypass("super-secret-token", "tenant:acme", kms);
    expect(JSON.stringify(sealed)).not.toContain("super-secret-token");
    expect(await openSecret(sealed, kms)).toBe("super-secret-token");
  });
});
