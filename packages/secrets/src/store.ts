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

/** The env var name backing each app secret key (the canonical source for go-live env checks, #64). */
export function secretEnvVarName(key: AppSecretKey): string {
  return ENV_VARS[key];
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
    const value = this.env[ENV_VARS[key]];
    if (value === undefined || value === "") {
      throw new Error(`Missing secret: ${key} (${ENV_VARS[key]})`);
    }
    return value;
  }
}
