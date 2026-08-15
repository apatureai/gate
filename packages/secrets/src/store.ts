/**
 * App-level secrets Gate holds (TRD §8, §12; §15.6 adds the enterprise
 * `engineEndpoint`). Resolved from a KMS-backed store in production; the env
 * resolver here is the dev/local seam.
 */
export const APP_SECRET_KEYS = [
  "githubAppPrivateKey",
  "webhookSecret",
  "engineApiKey",
  "engineHmacSecret",
  "stripeSecretKey",
  "stripeWebhookSecret",
  "engineEndpoint",
] as const;

export type AppSecretKey = (typeof APP_SECRET_KEYS)[number];

export interface SecretStore {
  get(key: AppSecretKey): Promise<string>;
}

const ENV_VARS: Record<AppSecretKey, string> = {
  githubAppPrivateKey: "GITHUB_APP_PRIVATE_KEY",
  webhookSecret: "GITHUB_WEBHOOK_SECRET",
  engineApiKey: "GATE_ENGINE_API_KEY",
  engineHmacSecret: "GATE_ENGINE_HMAC_SECRET",
  stripeSecretKey: "STRIPE_SECRET_KEY",
  stripeWebhookSecret: "STRIPE_WEBHOOK_SECRET",
  engineEndpoint: "GATE_ENGINE_ENDPOINT",
};

/**
 * Pre-2026-08-09 names for the three engine-client variables, kept readable so
 * an environment provisioned before the rename still works. They named the
 * `judgment-engine` repository, which is now `verdict`, and they were never
 * Gate's to own: these configure Gate's client for whatever critique service it
 * is pointed at. Reading one emits a deprecation warning.
 */
const LEGACY_ENV_VARS: Partial<Record<AppSecretKey, string>> = {
  engineApiKey: "JUDGMENT_ENGINE_API_KEY",
  engineHmacSecret: "JUDGMENT_ENGINE_HMAC_SECRET",
  engineEndpoint: "JUDGMENT_ENGINE_ENDPOINT",
};

/** The env var name backing each app secret key (the canonical source for go-live env checks, #64). */
export function secretEnvVarName(key: AppSecretKey): string {
  return ENV_VARS[key];
}

/** The deprecated env var name for a key, or null if it never had one. */
export function legacySecretEnvVarName(key: AppSecretKey): string | null {
  return LEGACY_ENV_VARS[key] ?? null;
}

/**
 * Deprecated alias keyed by canonical env var name. The go-live readiness check
 * reads this so a still-migrating environment boots on the same names the
 * secret store accepts, rather than passing one gate and failing the other.
 */
export const LEGACY_ENV_VAR_ALIASES: Readonly<Record<string, string>> = Object.fromEntries(
  APP_SECRET_KEYS.flatMap((key) => {
    const legacy = LEGACY_ENV_VARS[key];
    return legacy ? [[ENV_VARS[key], legacy] as const] : [];
  }),
);

/** An env var read, and whether it came from the deprecated name. */
export type EnvVarResolution = {
  value: string | undefined;
  legacyName: string | null;
};

/**
 * Read one app secret from env, preferring the canonical `GATE_*` name and
 * falling back to the deprecated one. `legacyName` is set only when the
 * fallback actually supplied the value, so callers can warn precisely.
 */
export function resolveSecretEnv(
  key: AppSecretKey,
  env: NodeJS.ProcessEnv = process.env,
): EnvVarResolution {
  const value = env[ENV_VARS[key]];
  if (value !== undefined && value !== "") return { value, legacyName: null };
  const legacyName = LEGACY_ENV_VARS[key];
  if (legacyName) {
    const legacyValue = env[legacyName];
    if (legacyValue !== undefined && legacyValue !== "") {
      return { value: legacyValue, legacyName };
    }
  }
  return { value: undefined, legacyName: null };
}

/** A value that arrived under a deprecated name, and the name it should move to. */
export type LegacyEnvVarUse = {
  legacyName: string;
  canonicalName: string;
};

/** The engine client's three settings, plus the deprecated names that supplied any of them. */
export type EngineClientEnv = {
  endpoint: string;
  apiKey: string | undefined;
  hmacSecret: string | undefined;
  legacyNamesUsed: LegacyEnvVarUse[];
};

/**
 * Resolve the engine client's endpoint, API key and HMAC secret from env,
 * accepting the deprecated `JUDGMENT_ENGINE_*` names. Absent endpoint stays the
 * empty string, which is what makes an unconfigured run end in a neutral Check
 * Run rather than an error.
 */
export function resolveEngineClientEnv(env: NodeJS.ProcessEnv = process.env): EngineClientEnv {
  const legacyNamesUsed: LegacyEnvVarUse[] = [];
  const read = (key: AppSecretKey): string | undefined => {
    const { value, legacyName } = resolveSecretEnv(key, env);
    if (legacyName) legacyNamesUsed.push({ legacyName, canonicalName: ENV_VARS[key] });
    return value;
  };
  const endpoint = read("engineEndpoint");
  const apiKey = read("engineApiKey");
  const hmacSecret = read("engineHmacSecret");
  return { endpoint: endpoint ?? "", apiKey, hmacSecret, legacyNamesUsed };
}

/**
 * The engine settings a run cannot proceed without, by canonical name.
 *
 * The endpoint is where to send the job; the HMAC secret is what signs it, and
 * every engine request is signed (verdict refuses to start without
 * `ENGINE_HMAC_SECRET` and answers 401 to anything unsigned), so an endpoint
 * with no secret is a run that will be rejected on submit. The API key is
 * genuinely optional: a self-hosted engine authenticates on the signature alone.
 *
 * Callers use this to fail a run visibly at setup rather than letting it die
 * later as a generic "engine unavailable".
 */
export function missingEngineSettings(env: EngineClientEnv): string[] {
  const missing: string[] = [];
  if (env.endpoint.trim().length === 0) missing.push(ENV_VARS.engineEndpoint);
  if ((env.hmacSecret ?? "").trim().length === 0) missing.push(ENV_VARS.engineHmacSecret);
  return missing;
}

/** Env var names for every required app secret: the source of truth for the production-readiness check (#64). */
export const APP_SECRET_ENV_VARS: readonly string[] = APP_SECRET_KEYS.map((k) => ENV_VARS[k]);

/**
 * Resolves app secrets from environment variables. The production store binds
 * the same interface to a managed KMS/secret manager (AWS Secrets Manager).
 */
export class EnvSecretStore implements SecretStore {
  private readonly env: NodeJS.ProcessEnv;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.env = env;
  }

  async get(key: AppSecretKey): Promise<string> {
    const { value, legacyName } = resolveSecretEnv(key, this.env);
    if (value === undefined) {
      throw new Error(`Missing secret: ${key} (${ENV_VARS[key]})`);
    }
    if (legacyName) {
      console.warn(
        `Apature Gate: ${legacyName} is deprecated and will be dropped; rename it to ${ENV_VARS[key]}.`,
      );
    }
    return value;
  }
}
