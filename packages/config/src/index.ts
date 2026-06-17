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

/** Thrown when a `.designreview.yml` fails validation; carries readable issues. */
export class ConfigValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[] | z.ZodError) {
    const list =
      issues instanceof z.ZodError
        ? issues.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        : issues;
    super(`Invalid .designreview.yml:\n${list.map((s) => `  - ${s}`).join("\n")}`);
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
      waitSeconds: raw.preview.wait_seconds,
      readySelector: raw.preview.ready_selector,
      protectionBypassSecretName: raw.preview.protection_bypass,
      authStateSecretName: raw.preview.auth,
    },
    routes: {
      always: raw.routes.always,
      maxPerPr: raw.routes.max_per_pr,
      map: raw.routes.map,
    },
    viewports: raw.viewports,
    darkMode: raw.dark_mode,
    brand: raw.brand,
    rules: {
      gate: raw.rules.gate,
      minSeverityToComment: raw.rules.min_severity_to_comment,
      suppress: raw.rules.suppress,
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
 * Load a `.designreview.yml` from raw text. A null/empty file yields the full
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

/** The fully-defaulted config used when no `.designreview.yml` is present. */
export const DEFAULT_CONFIG: NormalizedDesignReviewConfig = parseDesignReviewConfig({});
