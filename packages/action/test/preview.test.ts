import { DEFAULT_CONFIG } from "@gate/config";
import type { NormalizedDesignReviewConfig } from "@gate/types";
import { describe, expect, it } from "vitest";
import { resolvePreviewUrl } from "../src/index.js";

function configWith(overrides: Partial<NormalizedDesignReviewConfig["preview"]>): NormalizedDesignReviewConfig {
  return { ...DEFAULT_CONFIG, preview: { ...DEFAULT_CONFIG.preview, ...overrides } };
}

const base = { prNumber: 42, headSha: "abcdef1234567890" };

describe("resolvePreviewUrl", () => {
  it("prefers the explicit input", () => {
    const out = resolvePreviewUrl({ ...base, explicitUrl: "https://preview.example.com" }, DEFAULT_CONFIG);
    expect(out).toEqual({
      ok: true,
      resolution: {
        url: "https://preview.example.com/",
        source: "explicit",
        provider: "explicit",
        provenance: "explicit preview-url input",
      },
    });
  });

  it("rejects an invalid explicit URL", () => {
    const out = resolvePreviewUrl({ ...base, explicitUrl: "not-a-url" }, DEFAULT_CONFIG);
    expect(out.ok).toBe(false);
  });

  it("fills url_template with pr and sha", () => {
    const config = configWith({ source: "netlify", urlTemplate: "https://pr-{pr}-{short_sha}.example.com" });
    const out = resolvePreviewUrl(base, config);
    expect(out).toMatchObject({
      ok: true,
      resolution: { url: "https://pr-42-abcdef1.example.com/", source: "url_template", provider: "netlify" },
    });
  });

  it("trusts an allowlisted provider-bot comment with a matching domain", () => {
    const config = configWith({ source: "vercel" });
    const out = resolvePreviewUrl(
      {
        ...base,
        comments: [
          { author: "vercel[bot]", body: "Preview ready: https://acme-web-git-pr42.vercel.app 🚀" },
        ],
      },
      config,
    );
    expect(out).toMatchObject({
      ok: true,
      resolution: { url: "https://acme-web-git-pr42.vercel.app/", source: "provider-bot", provider: "vercel" },
    });
  });

  it("never trusts a free-text comment from a non-allowlisted author", () => {
    const config = configWith({ source: "vercel" });
    const out = resolvePreviewUrl(
      {
        ...base,
        comments: [
          { author: "random-user", body: "try https://evil.vercel.app" },
          { author: "vercel[bot]", body: "Building..." }, // no URL
        ],
      },
      config,
    );
    expect(out.ok).toBe(false);
  });

  it("ignores a provider-bot comment whose URL is off-domain", () => {
    const config = configWith({ source: "vercel" });
    const out = resolvePreviewUrl(
      { ...base, comments: [{ author: "vercel[bot]", body: "see https://evil.example.com" }] },
      config,
    );
    expect(out.ok).toBe(false);
  });

  it("falls back to local build-and-serve when a preview-command is set", () => {
    const out = resolvePreviewUrl({ ...base, previewCommand: "pnpm preview", localServePort: 4321 }, DEFAULT_CONFIG);
    expect(out).toMatchObject({
      ok: true,
      resolution: { url: "http://127.0.0.1:4321/", source: "local", provider: "local" },
    });
  });

  it("explains why nothing resolved", () => {
    const out = resolvePreviewUrl(base, DEFAULT_CONFIG);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/no preview URL found/);
  });
});
