import { describe, expect, it } from "vitest";
import { buildProposeConfigUrl, copyableConfig, validateConfig } from "../src/config-ui.js";

describe("validateConfig", () => {
  it("accepts valid YAML and returns the normalized config", () => {
    const result = validateConfig("dark_mode: true");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.darkMode).toBe(true);
  });

  it("surfaces schema errors", () => {
    const result = validateConfig("rules:\n  gate: everything");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.join(" ")).toMatch(/rules\.gate/);
  });

  it("surfaces YAML syntax errors", () => {
    const result = validateConfig("preview: [unclosed");
    expect(result.ok).toBe(false);
  });
});

describe("copyableConfig", () => {
  it("returns trimmed config text with a trailing newline", () => {
    expect(copyableConfig("  dark_mode: true  ")).toBe("dark_mode: true\n");
  });
});

describe("buildProposeConfigUrl (user-initiated, no contents:write)", () => {
  it("deep-links into GitHub's own new-file editor with the prefilled content", () => {
    const url = new URL(
      buildProposeConfigUrl({ owner: "acme", name: "web", yamlText: "dark_mode: true" }),
    );
    expect(url.origin + url.pathname).toBe("https://github.com/acme/web/new/main");
    expect(url.searchParams.get("filename")).toBe(".designreview.yml");
    expect(url.searchParams.get("value")).toBe("dark_mode: true");
    // It's a deep-link the user acts on; Gate performs no write itself.
    expect(url.hostname).toBe("github.com");
  });

  it("honors a custom branch + filename", () => {
    const url = new URL(
      buildProposeConfigUrl({ owner: "acme", name: "web", yamlText: "x: 1", branch: "dev", filename: "config/.designreview.yml" }),
    );
    expect(url.pathname).toBe("/acme/web/new/dev");
    expect(url.searchParams.get("filename")).toBe("config/.designreview.yml");
  });
});
