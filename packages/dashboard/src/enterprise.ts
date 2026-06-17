import { openSecret, type SealedSecret, sealSecret, type KmsKeyProvider } from "@gate/secrets";

/**
 * Enterprise tier (PRD §9; TRD §15.5): SSO and the in-VPC data-residency option.
 * Standard/paid accounts are fully-managed hosted serving with no customer key
 * management; only enterprise can point Gate at an in-VPC engine (#53). No BYOK.
 */
export type AccountTier = "free" | "paid" | "enterprise";

export type SsoProvider = "oidc" | "saml";

export interface SsoConfig {
  provider: SsoProvider;
  /** OIDC issuer base URL (or SAML IdP entityID). */
  issuer: string;
  clientId: string;
}

export interface OidcAuthorizeOptions {
  redirectUri: string;
  state: string;
  nonce: string;
  scopes?: string[];
}

/** Build an OIDC authorize URL for enterprise SSO login. */
export function buildOidcAuthorizeUrl(config: SsoConfig, options: OidcAuthorizeOptions): string {
  const url = new URL(`${config.issuer.replace(/\/$/, "")}/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("scope", (options.scopes ?? ["openid", "email", "profile"]).join(" "));
  url.searchParams.set("state", options.state);
  url.searchParams.set("nonce", options.nonce);
  return url.toString();
}

/** SSO is required for enterprise accounts. */
export function requiresSso(tier: AccountTier): boolean {
  return tier === "enterprise";
}

export function assertEnterpriseSso(tier: AccountTier, hasSso: boolean): void {
  if (requiresSso(tier) && !hasSso) {
    throw new Error("enterprise accounts must configure SSO");
  }
}

/** Only enterprise accounts may run an in-VPC engine; everyone else is hosted. */
export function canUseInVpcEngine(tier: AccountTier): boolean {
  return tier === "enterprise";
}

export function assertInVpcAllowed(tier: AccountTier): void {
  if (!canUseInVpcEngine(tier)) {
    throw new Error("in-VPC engineEndpoint is enterprise-only; standard/paid use fully-managed hosted serving");
  }
}

/** Seal an account's in-VPC engineEndpoint under the tenant CMK (enterprise only). */
export async function sealEngineEndpoint(
  tier: AccountTier,
  endpoint: string,
  keyId: string,
  kms: KmsKeyProvider,
): Promise<SealedSecret> {
  assertInVpcAllowed(tier);
  return sealSecret(endpoint, keyId, kms);
}

/** Decrypt the stored in-VPC engineEndpoint, or null for hosted accounts. */
export async function resolveEngineEndpoint(
  sealed: SealedSecret | null,
  kms: KmsKeyProvider,
): Promise<string | null> {
  if (!sealed) return null;
  return openSecret(sealed, kms);
}
