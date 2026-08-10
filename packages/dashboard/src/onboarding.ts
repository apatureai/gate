import { sealSecret, type KmsKeyProvider, type SealedSecret } from "@gate/secrets";
import type { PreviewSource } from "@gate/types";
import { stringify } from "yaml";
import { validateConfig, type ConfigValidation } from "./config-ui.js";

/**
 * Onboarding flow (TRD §3.1, §12, §5.2): collect the brand block (the primary
 * ask), the `protection_bypass` secret (KMS-stored), and the preview source/env,
 * documenting Netlify and Cloudflare equivalents. Produces a valid
 * `.designreview.yml` the customer adopts (Gate never writes it, #18).
 */
export interface OnboardingStep {
  key: "brand" | "protection_bypass" | "preview";
  label: string;
  primary?: boolean;
}

export const ONBOARDING_STEPS: readonly OnboardingStep[] = [
  { key: "brand", label: "Describe your product, audience, tone, and design rules", primary: true },
  { key: "preview", label: "Where do preview deployments come from?" },
  { key: "protection_bypass", label: "Protection-bypass secret (if previews are gated)" },
] as const;

export interface ProviderGuide {
  defaultEnvironment: string;
  /** Env var name for the protection-bypass secret, if the provider gates previews. */
  bypassSecretEnv?: string;
  docs: string;
}

/** Per-provider preview setup, incl. Netlify and Cloudflare equivalents. */
export const PROVIDER_GUIDES: Partial<Record<PreviewSource, ProviderGuide>> = {
  vercel: {
    defaultEnvironment: "Preview",
    bypassSecretEnv: "VERCEL_AUTOMATION_BYPASS_SECRET",
    docs: "Vercel: enable Protection Bypass for Automation and store the secret; previews are the 'Preview' environment.",
  },
  netlify: {
    defaultEnvironment: "Deploy Preview",
    docs: "Netlify equivalent: Deploy Previews per PR; use a password/JWT or open preview, and the 'Deploy Preview' context.",
  },
  cloudflare: {
    defaultEnvironment: "Preview",
    docs: "Cloudflare Pages equivalent: preview deployments on *.pages.dev; use Access service tokens if gated.",
  },
  render: {
    defaultEnvironment: "Preview",
    docs: "Render equivalent: PR preview environments on *.onrender.com.",
  },
};

export interface OnboardingInput {
  brand: string;
  source: PreviewSource;
  environment?: string;
  /** Name of the protection-bypass secret to reference (value stored separately, KMS). */
  protectionBypassSecretName?: string | null;
}

/** Build the `.designreview.yml` text from onboarding answers, validated. */
export function buildOnboardingConfig(input: OnboardingInput): { yaml: string; validation: ConfigValidation } {
  const environment =
    input.environment ?? PROVIDER_GUIDES[input.source]?.defaultEnvironment ?? "Preview";
  const raw = {
    preview: {
      source: input.source,
      environment,
      protection_bypass: input.protectionBypassSecretName ?? null,
    },
    brand: input.brand,
  };
  const yaml = stringify(raw);
  return { yaml, validation: validateConfig(yaml) };
}

/** KMS-store the protection-bypass secret value (sealed under the tenant CMK). */
export async function sealProtectionBypass(
  value: string,
  keyId: string,
  kms: KmsKeyProvider,
): Promise<SealedSecret> {
  return sealSecret(value, keyId, kms);
}
