import { ConfigValidationError, loadDesignReviewConfig } from "@gate/config";
import type { NormalizedDesignReviewConfig } from "@gate/types";

/**
 * Config UI core (TRD §13, §12, §11): validate `.gate.yml` edits against
 * the schema and propose changes the customer applies themselves: a copyable
 * config or a user-initiated GitHub PR. Gate NEVER writes to the repo (no
 * `contents: write`); the only "apply" path is a prefilled GitHub new-file URL
 * the user opens and commits.
 */
export type ConfigValidation =
  | { ok: true; config: NormalizedDesignReviewConfig }
  | { ok: false; issues: string[] };

/** Validate edited YAML against the config schema, surfacing readable issues. */
export function validateConfig(yamlText: string): ConfigValidation {
  try {
    return { ok: true, config: loadDesignReviewConfig(yamlText) };
  } catch (err) {
    if (err instanceof ConfigValidationError) return { ok: false, issues: err.issues };
    return { ok: false, issues: [err instanceof Error ? err.message : String(err)] };
  }
}

/** The copyable config output (the user pastes it into their repo). */
export function copyableConfig(yamlText: string): string {
  return `${yamlText.trim()}\n`;
}

export interface ProposeConfigOptions {
  owner: string;
  name: string;
  yamlText: string;
  branch?: string;
  filename?: string;
}

/**
 * Build a prefilled GitHub "new file" URL so the user opens the PR themselves.
 * Gate writes nothing; this only deep-links into GitHub's own editor.
 */
export function buildProposeConfigUrl(options: ProposeConfigOptions): string {
  const branch = options.branch ?? "main";
  const filename = options.filename ?? ".gate.yml";
  const url = new URL(`https://github.com/${options.owner}/${options.name}/new/${branch}`);
  url.searchParams.set("filename", filename);
  url.searchParams.set("value", options.yamlText);
  return url.toString();
}
