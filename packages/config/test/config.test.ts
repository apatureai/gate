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
        readyPath: null,
        readyStatus: null,
        protectionBypassSecretName: null,
        authStateSecretName: null,
        forkPreview: false,
      },
      routes: { always: ["/"], maxPerPr: 5, map: {} },
      viewports: ["mobile", "desktop"],
      darkMode: false,
      brand: null,
      rules: {
        gate: "none",
        minSeverityToComment: "nit",
        suppress: [],
        // Measurements are SHOWN by default and never block by default. `off`
        // is never the default, because silence is exactly what this contract
        // closes, and `block` is never the vendor's call to make.
        measurements: "advisory",
        measurementSuppress: [],
      },
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
  ready_path: /healthz
  ready_status: [200, 204]
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
    expect(config.preview.readyPath).toBe("/healthz");
    expect(config.preview.readyStatus).toEqual([200, 204]);
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

  it("passes a repository's determinism-check opt-in through to the engine", () => {
    expect(loadDesignReviewConfig("verify_stability: true").verifyStability).toBe(true);
  });

  it("omits the opt-in entirely when nobody asked for it", () => {
    // Not `false`: this field crosses to the engine inside the config object,
    // and a repository that never asked has to produce the request Gate sent
    // before the setting existed, so an engine that predates it sees no change.
    expect(loadDesignReviewConfig(null)).not.toHaveProperty("verifyStability");
    expect(loadDesignReviewConfig("verify_stability: false")).not.toHaveProperty("verifyStability");
  });

  it("still catches a typo of it, like every other key", () => {
    expect(() => parseDesignReviewConfig({ verify_stabilty: true })).toThrow(ConfigValidationError);
  });
});

/**
 * `rules.measurements`: the key that says what the engine's MEASURED facts may
 * do on this repository. Three values, and the default is the middle one on
 * purpose. `off` is never the default, because silence is what this contract
 * closes; `block` is never the default, because merge-gating is the repo
 * owner's call and never the vendor's.
 */
describe("rules.measurements", () => {
  it("accepts each of the three modes and normalizes it unchanged", () => {
    for (const mode of ["off", "advisory", "block"] as const) {
      expect(loadDesignReviewConfig(`rules:\n  measurements: ${mode}\n`).rules.measurements).toBe(
        mode,
      );
    }
  });

  it("defaults to advisory when the file omits it, with or without a rules block", () => {
    expect(loadDesignReviewConfig(null).rules.measurements).toBe("advisory");
    expect(loadDesignReviewConfig("rules:\n  gate: blockers\n").rules.measurements).toBe("advisory");
  });

  it("rejects a fourth mode, and names the key in the message", () => {
    expect.assertions(2);
    try {
      parseDesignReviewConfig({ rules: { measurements: "warn" } });
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigValidationError);
      expect((err as ConfigValidationError).issues.join(" ")).toMatch(/rules\.measurements/);
    }
  });

  it("rejects a boolean for it, which is the plausible wrong guess", () => {
    expect(() => parseDesignReviewConfig({ rules: { measurements: true } })).toThrow(
      ConfigValidationError,
    );
  });

  it("carries the suppression list alongside it, defaulting to empty", () => {
    expect(loadDesignReviewConfig(null).rules.measurementSuppress).toEqual([]);
    expect(
      loadDesignReviewConfig("rules:\n  measurement_suppress: [contrast, '#hero']\n").rules
        .measurementSuppress,
    ).toEqual(["contrast", "#hero"]);
  });

  it("rejects a bare string where the suppression list belongs", () => {
    expect(() => parseDesignReviewConfig({ rules: { measurement_suppress: "contrast" } })).toThrow(
      ConfigValidationError,
    );
  });

  /**
   * The upgrade consideration, stated as a test because it is a real one.
   *
   * `rules` is `.strict()`, so a gate build that predates this key rejects the
   * whole file rather than ignoring the line: a repository that adopts
   * `rules.measurements` has raised its minimum Gate version. This is the
   * mechanism that makes that true, and it is the same mechanism that turns
   * `viewport:` into an error instead of a silently ignored typo.
   */
  it("is a closed schema: an unknown rules key fails the file, it is not ignored", () => {
    expect(() => parseDesignReviewConfig({ rules: { measurement: "block" } })).toThrow(
      ConfigValidationError,
    );
    expect(() => parseDesignReviewConfig({ rules: { measurements_mode: "block" } })).toThrow(
      ConfigValidationError,
    );
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
