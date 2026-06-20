import { describe, expect, it } from "vitest";
import {
  ConfigValidationError,
  DEFAULT_CONFIG,
  loadDesignReviewConfig,
  parseDesignReviewConfig,
} from "../src/index.js";

describe("defaults", () => {
  it("a missing/empty file yields full defaults (config is optional)", () => {
    expect(loadDesignReviewConfig(null)).toEqual(DEFAULT_CONFIG);
    expect(loadDesignReviewConfig("")).toEqual(DEFAULT_CONFIG);
    expect(loadDesignReviewConfig("   ")).toEqual(DEFAULT_CONFIG);
  });

  it("every field has a working default", () => {
    expect(DEFAULT_CONFIG).toEqual({
      preview: {
        source: "vercel",
        environment: "Preview",
        urlTemplate: null,
        waitSeconds: 0,
        readySelector: null,
        protectionBypassSecretName: null,
        authStateSecretName: null,
        forkPreview: false,
      },
      routes: { always: ["/"], maxPerPr: 5, map: {} },
      viewports: ["mobile", "desktop"],
      darkMode: false,
      brand: null,
      rules: { gate: "none", minSeverityToComment: "nit", suppress: [] },
      tokens: { source: null, values: {} },
    });
  });
});

describe("parsing + normalization", () => {
  it("normalizes snake_case YAML to the engine contract", () => {
    const yaml = `
preview:
  source: netlify
  environment: Deploy Preview
  url_template: https://pr-{pr}.example.com
  wait_seconds: 5
  protection_bypass: VERCEL_BYPASS
  auth: STORAGE_STATE
  fork_preview: true
routes:
  always: ["/", "/pricing"]
  max_per_pr: 3
  map: { "src/app/checkout": "/checkout" }
viewports: [mobile, tablet, desktop]
dark_mode: true
brand: |
  Calm, trustworthy fintech.
rules:
  gate: blockers
  min_severity_to_comment: minor
  suppress: ["#cookie-banner"]
tokens:
  source: tokens.json
  values: { "color.accent": "#5B5BD6" }
`;
    const config = loadDesignReviewConfig(yaml);
    expect(config.preview.source).toBe("netlify");
    expect(config.preview.urlTemplate).toBe("https://pr-{pr}.example.com");
    expect(config.preview.waitSeconds).toBe(5);
    expect(config.preview.protectionBypassSecretName).toBe("VERCEL_BYPASS");
    expect(config.preview.authStateSecretName).toBe("STORAGE_STATE");
    expect(config.preview.forkPreview).toBe(true);
    expect(config.routes.maxPerPr).toBe(3);
    expect(config.routes.map).toEqual({ "src/app/checkout": "/checkout" });
    expect(config.viewports).toEqual(["mobile", "tablet", "desktop"]);
    expect(config.darkMode).toBe(true);
    expect(config.brand).toContain("fintech");
    expect(config.rules.gate).toBe("blockers");
    expect(config.tokens).toEqual({ source: "tokens.json", values: { "color.accent": "#5B5BD6" } });
  });

  it("fills defaults for partially-specified config", () => {
    const config = loadDesignReviewConfig("dark_mode: true");
    expect(config.darkMode).toBe(true);
    expect(config.routes.always).toEqual(["/"]);
    expect(config.preview.source).toBe("vercel");
  });
});

describe("validation errors are surfaced", () => {
  it("rejects an unknown gate mode with a readable message", () => {
    expect.assertions(2);
    try {
      parseDesignReviewConfig({ rules: { gate: "everything" } });
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigValidationError);
      expect((err as ConfigValidationError).issues.join(" ")).toMatch(/rules\.gate/);
    }
  });

  it("rejects unknown top-level keys (typo protection)", () => {
    expect(() => parseDesignReviewConfig({ viewport: ["mobile"] })).toThrow(ConfigValidationError);
  });

  it("rejects invalid types", () => {
    expect(() => parseDesignReviewConfig({ dark_mode: "yes" })).toThrow(ConfigValidationError);
  });

  it("wraps YAML syntax errors", () => {
    expect(() => loadDesignReviewConfig("preview: [unclosed")).toThrow(ConfigValidationError);
  });
});
