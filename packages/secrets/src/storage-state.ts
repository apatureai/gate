import { openSecret, type SealedSecret, sealSecret } from "./envelope.js";
import type { KmsKeyProvider } from "./kms.js";

/**
 * storageState auth wizard support (TRD §4.3, §12). The browser login is
 * recorded by Playwright in the capture repo (#25); Gate's responsibility is to
 * origin-scope the cookies, encrypt the storageState under the tenant KMS key,
 * and store it per repo. storageState is disabled on fork PRs at use time
 * (`storageStateForPr`, #35).
 */
export interface StorageStateCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
  [key: string]: unknown;
}

export interface StorageStateOrigin {
  origin: string;
  localStorage?: Array<{ name: string; value: string }>;
}

export interface StorageState {
  cookies: StorageStateCookie[];
  origins: StorageStateOrigin[];
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return "";
  }
}

function cookieDomainCoversHost(cookieDomain: string, host: string): boolean {
  const domain = cookieDomain.startsWith(".") ? cookieDomain.slice(1) : cookieDomain;
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * Keep only cookies whose domain covers an allowed origin host, and only
 * localStorage origins in the allowlist, so a recorded session can't smuggle
 * cookies/state for unrelated domains.
 */
export function originScopeStorageState(state: StorageState, allowedOrigins: string[]): StorageState {
  const hosts = allowedOrigins.map(hostOf).filter(Boolean);
  const allowed = new Set(allowedOrigins);
  return {
    cookies: state.cookies.filter((c) => hosts.some((h) => cookieDomainCoversHost(c.domain, h))),
    origins: state.origins.filter((o) => allowed.has(o.origin)),
  };
}

/** Encrypt storageState under the tenant CMK (envelope). */
export async function sealStorageState(
  state: StorageState,
  keyId: string,
  kms: KmsKeyProvider,
): Promise<SealedSecret> {
  return sealSecret(JSON.stringify(state), keyId, kms);
}

/** Decrypt storageState at point of use. */
export async function openStorageState(sealed: SealedSecret, kms: KmsKeyProvider): Promise<StorageState> {
  return JSON.parse(await openSecret(sealed, kms)) as StorageState;
}

export interface StorageStateArtifact {
  sealed: SealedSecret;
  cookieCount: number;
  originCount: number;
}

/**
 * One-time wizard output: origin-scope then encrypt under the tenant key,
 * yielding the artifact stored per repo.
 */
export async function prepareStorageStateArtifact(input: {
  state: StorageState;
  allowedOrigins: string[];
  keyId: string;
  kms: KmsKeyProvider;
}): Promise<StorageStateArtifact> {
  const scoped = originScopeStorageState(input.state, input.allowedOrigins);
  const sealed = await sealStorageState(scoped, input.keyId, input.kms);
  return { sealed, cookieCount: scoped.cookies.length, originCount: scoped.origins.length };
}
