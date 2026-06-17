import { LocalKms } from "@gate/secrets";
import { describe, expect, it } from "vitest";
import {
  assertEnterpriseSso,
  assertInVpcAllowed,
  buildOidcAuthorizeUrl,
  canUseInVpcEngine,
  requiresSso,
  resolveEngineEndpoint,
  sealEngineEndpoint,
} from "../src/enterprise.js";

const kms = LocalKms.fromPassphrase("tenant-root-passphrase-1234567890");

describe("SSO", () => {
  it("builds an OIDC authorize URL", () => {
    const url = new URL(
      buildOidcAuthorizeUrl(
        { provider: "oidc", issuer: "https://idp.acme.com", clientId: "cid" },
        { redirectUri: "https://gate.app/sso/cb", state: "s", nonce: "n" },
      ),
    );
    expect(url.origin + url.pathname).toBe("https://idp.acme.com/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("openid email profile");
    expect(url.searchParams.get("nonce")).toBe("n");
  });

  it("requires SSO for enterprise only", () => {
    expect(requiresSso("enterprise")).toBe(true);
    expect(requiresSso("paid")).toBe(false);
    expect(() => assertEnterpriseSso("enterprise", false)).toThrow(/must configure SSO/);
    expect(() => assertEnterpriseSso("enterprise", true)).not.toThrow();
    expect(() => assertEnterpriseSso("free", false)).not.toThrow();
  });
});

describe("in-VPC residency gating", () => {
  it("only enterprise can use an in-VPC engine; standard/paid are fully managed", () => {
    expect(canUseInVpcEngine("enterprise")).toBe(true);
    expect(canUseInVpcEngine("paid")).toBe(false);
    expect(() => assertInVpcAllowed("paid")).toThrow(/enterprise-only/);
  });

  it("seals an enterprise engineEndpoint and resolves it; hosted accounts get null", async () => {
    const sealed = await sealEngineEndpoint("enterprise", "https://engine.internal.acme", "tenant:acme", kms);
    expect(JSON.stringify(sealed)).not.toContain("engine.internal.acme");
    expect(await resolveEngineEndpoint(sealed, kms)).toBe("https://engine.internal.acme");
    expect(await resolveEngineEndpoint(null, kms)).toBeNull(); // hosted default

    await expect(sealEngineEndpoint("paid", "https://x", "tenant:acme", kms)).rejects.toThrow(/enterprise-only/);
  });
});
