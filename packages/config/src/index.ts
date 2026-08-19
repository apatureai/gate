import type { NormalizedDesignReviewConfig } from "@gate/types";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { DesignReviewConfigSchema, type RawDesignReviewConfig } from "./schema.js";

export {
  DesignReviewConfigSchema,
  previewSourceEnum,
  viewportEnum,
  severityEnum,
  gateModeEnum,
} from "./schema.js";
export type { RawDesignReviewConfig } from "./schema.js";
export { COMPONENT_LIBRARY_IDS, detectComponentLibraryIds } from "./component-libraries.js";
export type { ComponentLibraryId } from "./component-libraries.js";

/** The config file Gate looks for. */
export const CONFIG_FILENAME = ".gate.yml";

/**
 * The pre-2026-08-09 name for the same file. Still read, with a warning, so a
 * repository configured before the rename keeps its settings instead of
 * silently falling back to defaults.
 */
export const LEGACY_CONFIG_FILENAME = ".designreview.yml";

/** Which config file to read, and whether it was found under the old name. */
export type ConfigFileResolution = {
  path: string;
  legacy: boolean;
};

/**
 * Resolve the config file to load. The requested path wins when it exists; when
 * it is the default `.gate.yml` and is absent, `.designreview.yml` is accepted
 * as a deprecated fallback. Returns null when neither exists, since the file is
 * optional and Gate then runs on defaults. `exists` is injected to keep this
 * pure and testable.
 */
export function resolveConfigPath(
  requestedPath: string | null | undefined,
  exists: (path: string) => boolean,
): ConfigFileResolution | null {
  const path = requestedPath?.trim() || CONFIG_FILENAME;
  if (exists(path)) return { path, legacy: false };
  if (path === CONFIG_FILENAME && exists(LEGACY_CONFIG_FILENAME)) {
    return { path: LEGACY_CONFIG_FILENAME, legacy: true };
  }
  return null;
}

/** Thrown when a `.gate.yml` fails validation; carries readable issues. */
export class ConfigValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[] | z.ZodError) {
    const list =
      issues instanceof z.ZodError
        ? issues.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        : issues;
    super(`Invalid .gate.yml:\n${list.map((s) => `  - ${s}`).join("\n")}`);
    this.name = "ConfigValidationError";
    this.issues = list;
  }
}

function normalize(raw: RawDesignReviewConfig): NormalizedDesignReviewConfig {
  return {
    preview: {
      source: raw.preview.source,
      environment: raw.preview.environment,
      urlTemplate: raw.preview.url_template,
      defaultBranchUrl: raw.preview.default_branch_url,
      waitSeconds: raw.preview.wait_seconds,
      readySelector: raw.preview.ready_selector,
      readyPath: raw.preview.ready_path,
      readyStatus: raw.preview.ready_status,
      protectionBypassSecretName: raw.preview.protection_bypass,
      authStateSecretName: raw.preview.auth,
      forkPreview: raw.preview.fork_preview,
    },
    routes: {
      always: raw.routes.always,
      maxPerPr: raw.routes.max_per_pr,
      map: raw.routes.map,
    },
    viewports: raw.viewports,
    darkMode: raw.dark_mode,
    // Present only when a repository asked for it. The engine treats the field
    // as optional and additive, so omitting it leaves the request Gate sends
    // byte-identical to the one it sent before this setting existed, and an
    // engine that has never heard of it is unaffected.
    ...(raw.verify_stability ? { verifyStability: true } : {}),
    brand: raw.brand,
    rules: {
      gate: raw.rules.gate,
      minSeverityToComment: raw.rules.min_severity_to_comment,
      suppress: raw.rules.suppress,
      measurements: raw.rules.measurements,
      measurementSuppress: raw.rules.measurement_suppress,
    },
    tokens: {
      source: raw.tokens.source,
      values: raw.tokens.values,
    },
  };
}

/** Validate an already-parsed config object and normalize it for the engine. */
export function parseDesignReviewConfig(input: unknown): NormalizedDesignReviewConfig {
  const result = DesignReviewConfigSchema.safeParse(input ?? {});
  if (!result.success) {
    throw new ConfigValidationError(result.error);
  }
  return normalize(result.data);
}

/**
 * Load a `.gate.yml` from raw text. A null/empty file yields the full
 * defaults (the file is optional); YAML syntax errors and schema errors both
 * surface as `ConfigValidationError`.
 */
export function loadDesignReviewConfig(
  yamlText: string | null | undefined,
): NormalizedDesignReviewConfig {
  if (yamlText == null || yamlText.trim() === "") {
    return DEFAULT_CONFIG;
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlText);
  } catch (err) {
    throw new ConfigValidationError([`YAML syntax: ${err instanceof Error ? err.message : String(err)}`]);
  }
  return parseDesignReviewConfig(parsed ?? {});
}

/** The fully-defaulted config used when no `.gate.yml` is present. */
export const DEFAULT_CONFIG: NormalizedDesignReviewConfig = parseDesignReviewConfig({});
