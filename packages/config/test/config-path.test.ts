import { describe, expect, it } from "vitest";
import {
  CONFIG_FILENAME,
  LEGACY_CONFIG_FILENAME,
  resolveConfigPath,
} from "../src/index.js";

/** An `exists` probe backed by a fixed set of paths. */
const present = (...paths: string[]) => (path: string) => paths.includes(path);

describe("resolveConfigPath", () => {
  it("prefers .gate.yml when it is there", () => {
    expect(resolveConfigPath(CONFIG_FILENAME, present(CONFIG_FILENAME))).toEqual({
      path: CONFIG_FILENAME,
      legacy: false,
    });
  });

  it("defaults to .gate.yml when no path is requested", () => {
    expect(resolveConfigPath(null, present(CONFIG_FILENAME))?.path).toBe(CONFIG_FILENAME);
    expect(resolveConfigPath("", present(CONFIG_FILENAME))?.path).toBe(CONFIG_FILENAME);
    expect(resolveConfigPath("  ", present(CONFIG_FILENAME))?.path).toBe(CONFIG_FILENAME);
  });

  it("falls back to the pre-rename .designreview.yml and flags it", () => {
    expect(resolveConfigPath(CONFIG_FILENAME, present(LEGACY_CONFIG_FILENAME))).toEqual({
      path: LEGACY_CONFIG_FILENAME,
      legacy: true,
    });
  });

  it("does not take the fallback when both exist", () => {
    const both = present(CONFIG_FILENAME, LEGACY_CONFIG_FILENAME);
    expect(resolveConfigPath(CONFIG_FILENAME, both)).toEqual({
      path: CONFIG_FILENAME,
      legacy: false,
    });
  });

  it("does not fall back for an explicitly requested non-default path", () => {
    // Asking for config/.gate.yml and getting the repo-root legacy file would
    // be a surprise, so a named path that is absent stays absent.
    expect(resolveConfigPath("config/.gate.yml", present(LEGACY_CONFIG_FILENAME))).toBeNull();
  });

  it("returns null when neither file exists (config is optional)", () => {
    expect(resolveConfigPath(CONFIG_FILENAME, present())).toBeNull();
  });
});
