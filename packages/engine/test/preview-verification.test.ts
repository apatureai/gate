import { describe, expect, it } from "vitest";
import { verifyPreviewHandoff } from "../src/index.js";

const baseSecrets = { protectionBypassSecretName: "BYPASS", authStateSecretName: "AUTH" };

describe("verifyPreviewHandoff", () => {
  it("forwards an allowlisted provider-bot URL on the matching domain", () => {
    const out = verifyPreviewHandoff({
      url: "https://acme-git-pr42.vercel.app",
      source: "provider-bot",
      provider: "vercel",
      isFork: false,
      ...baseSecrets,
    });
    expect(out).toMatchObject({ ok: true, source: "provider-bot", provider: "vercel" });
  });

  it("forwards a verified deployment_status URL (App path)", () => {
    const out = verifyPreviewHandoff({
      url: "https://preview.netlify.app",
      source: "deployment_status",
      provider: "netlify",
      isFork: false,
      ...baseSecrets,
    });
    expect(out.ok).toBe(true);
  });

  it("rejects an unverified-origin (free-text) source", () => {
    const out = verifyPreviewHandoff({
      url: "https://acme.vercel.app",
      source: "pr_comment_freetext",
      provider: "vercel",
      isFork: false,
      ...baseSecrets,
    });
    expect(out).toEqual({
      ok: false,
      notReviewed: "unverified_preview_source",
      reason: expect.stringContaining("not a verified origin"),
    });
  });

  it("rejects a provider/domain mismatch", () => {
    const out = verifyPreviewHandoff({
      url: "https://evil.example.com",
      source: "provider-bot",
      provider: "vercel",
      isFork: false,
      ...baseSecrets,
    });
    expect(out).toMatchObject({ ok: false, notReviewed: "unverified_preview_source" });
  });

  it("requires loopback for local-serve", () => {
    expect(
      verifyPreviewHandoff({ url: "http://127.0.0.1:3000", source: "local", provider: "local", isFork: false, ...baseSecrets }).ok,
    ).toBe(true);
    expect(
      verifyPreviewHandoff({ url: "http://evil.example.com", source: "local", provider: "local", isFork: false, ...baseSecrets }).ok,
    ).toBe(false);
  });

  it("accepts an explicit operator-supplied URL", () => {
    const out = verifyPreviewHandoff({
      url: "https://staging.acme.com",
      source: "explicit",
      provider: "explicit",
      isFork: false,
      ...baseSecrets,
    });
    expect(out.ok).toBe(true);
  });

  it("disables bypass + storageState secrets on fork PRs before handoff", () => {
    const out = verifyPreviewHandoff({
      url: "https://staging.acme.com",
      source: "explicit",
      provider: "explicit",
      isFork: true,
      ...baseSecrets,
    });
    expect(out).toMatchObject({ ok: true, protectionBypassSecretName: null, authStateSecretName: null });
  });

  it("rejects a non-http URL", () => {
    const out = verifyPreviewHandoff({
      url: "file:///etc/passwd",
      source: "explicit",
      provider: "explicit",
      isFork: false,
      ...baseSecrets,
    });
    expect(out.ok).toBe(false);
  });
});
