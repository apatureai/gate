import { APP_SECRET_ENV_VARS, LEGACY_ENV_VAR_ALIASES } from "@gate/secrets";

/**
 * Production-readiness env check (#64). Go-live needs a set of secrets + infra
 * URLs configured; a missing one otherwise surfaces as an opaque runtime failure
 * deep in a request (a nil secret, a failed DB connect), or worse, silently.
 * This turns "did I set every secret?" into a single fail-fast boot error that
 * lists EVERY missing variable at once, so the operator fixes them in one pass.
 *
 * The secret env-var names come from `@gate/secrets` (the canonical source), so
 * this list can't drift from the actual `SecretStore`. Pure; no I/O.
 */

/** App secrets + the two infra URLs the app cannot boot without (go-live checklist, #64). */
export const PRODUCTION_ENV_VARS: readonly string[] = [
  "GITHUB_APP_ID",
  ...APP_SECRET_ENV_VARS, // GITHUB_APP_PRIVATE_KEY, GITHUB_WEBHOOK_SECRET, GATE_ENGINE_*, STRIPE_*
  "DATABASE_URL",
  "REDIS_URL",
  "GATE_SCREENSHOT_OBJECT_URL_TEMPLATE",
  "SCREENSHOT_CAPABILITY_SECRET",
  "FEEDBACK_TOKEN_SECRET",
];

export interface EnvCheckResult {
  ok: boolean;
  missing: string[];
}

const isSet = (env: NodeJS.ProcessEnv, name: string): boolean => {
  const v = env[name];
  return v !== undefined && v.trim() !== "";
};

/**
 * Which of `names` are absent or blank in `env` (the missing-required set). A
 * variable set only under its deprecated pre-rename alias counts as present, so
 * this check and `EnvSecretStore` agree about what a bootable environment is;
 * the store is what emits the deprecation warning when it actually reads one.
 * Missing variables are always reported under the canonical name.
 */
export function checkRequiredEnv(
  env: NodeJS.ProcessEnv,
  names: readonly string[] = PRODUCTION_ENV_VARS,
): EnvCheckResult {
  const missing = names.filter((n) => {
    if (isSet(env, n)) return false;
    const alias = LEGACY_ENV_VAR_ALIASES[n];
    return !(alias !== undefined && isSet(env, alias));
  });
  return { ok: missing.length === 0, missing };
}

/**
 * Throw a single, aggregated error if any required production env var is missing.
 * Call from the composition root's `start()` BEFORE serving traffic. The error
 * names every missing var (not just the first) and points at the runbook.
 */
export function assertProductionEnv(
  env: NodeJS.ProcessEnv = process.env,
  names: readonly string[] = PRODUCTION_ENV_VARS,
): void {
  const { ok, missing } = checkRequiredEnv(env, names);
  if (!ok) {
    throw new Error(
      `Production readiness: missing required environment variable(s): ${missing.join(", ")}. ` +
        `Set them before go-live (see the Configuration section of README.md, #64).`,
    );
  }
}
