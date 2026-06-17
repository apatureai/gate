import { storageStateForPr } from "@gate/secrets";
import type { GateReviewRequest } from "@gate/types";

/**
 * Gate-side preview-URL provenance guard before engine handoff (TRD §8).
 *
 * Gate answers "is this URL one this installation or configured workflow
 * legitimately produced?" — and independently re-checks provider/domain here
 * rather than trusting the discovery layer (defense-in-depth). Deep SSRF,
 * internal-IP egress deny, and DNS-rebind recheck remain engine-owned; do NOT
 * duplicate those here.
 */

type PreviewProvider = GateReviewRequest["preview"]["provider"];

/** Origins Gate will forward. `deployment_status` is the App-path source (#55). */
export const VERIFIED_SOURCES = [
  "deployment_status",
  "explicit",
  "url_template",
  "provider-bot",
  "local",
] as const;
export type VerifiedSource = (typeof VERIFIED_SOURCES)[number];

/** Canonical provider domain suffixes for the handoff sanity check. */
const PROVIDER_DOMAIN_SUFFIXES: Partial<Record<PreviewProvider, string[]>> = {
  vercel: ["vercel.app"],
  netlify: ["netlify.app"],
  cloudflare: ["pages.dev"],
  render: ["onrender.com"],
};

export interface PreviewHandoffInput {
  url: string;
  /** Discovery source as resolved upstream (treated as untrusted input here). */
  source: string;
  provider: PreviewProvider;
  isFork: boolean;
  /** Per-repo secret names from config; disabled on fork before handoff. */
  protectionBypassSecretName: string | null;
  authStateSecretName: string | null;
}

export type PreviewHandoffResult =
  | {
      ok: true;
      url: string;
      provider: PreviewProvider;
      source: VerifiedSource;
      /** null on fork PRs (auth/bypass disabled before handoff). */
      protectionBypassSecretName: string | null;
      authStateSecretName: string | null;
    }
  | { ok: false; notReviewed: "unverified_preview_source"; reason: string };

function parseHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]" ||
    hostname.startsWith("127.")
  );
}

function hostMatches(host: string, suffixes: string[]): boolean {
  return suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

const unverified = (reason: string): PreviewHandoffResult => ({
  ok: false,
  notReviewed: "unverified_preview_source",
  reason,
});

/**
 * Verify a resolved preview URL is safe to hand to the engine. Returns the
 * sanitized handoff (secrets disabled on fork) or an `unverified_preview_source`
 * not-reviewed result for any free-text or origin-mismatched URL.
 */
export function verifyPreviewHandoff(input: PreviewHandoffInput): PreviewHandoffResult {
  if (!(VERIFIED_SOURCES as readonly string[]).includes(input.source)) {
    return unverified(`source "${input.source}" is not a verified origin`);
  }
  const source = input.source as VerifiedSource;

  const url = parseHttpUrl(input.url);
  if (!url) return unverified(`not a valid http(s) URL: ${input.url}`);

  // provider-bot URLs must come from a known hosted provider.
  const suffixes = PROVIDER_DOMAIN_SUFFIXES[input.provider];
  if (source === "provider-bot" && !suffixes) {
    return unverified(`provider-bot source requires a known provider, got "${input.provider}"`);
  }

  // Provider/domain sanity check per resolved provider.
  if (suffixes) {
    if (!hostMatches(url.host, suffixes)) {
      return unverified(`host ${url.host} does not match ${input.provider} domain`);
    }
  } else if (input.provider === "local") {
    if (!isLoopback(url.hostname)) {
      return unverified(`local preview must be loopback, got ${url.hostname}`);
    }
  }
  // provider "explicit" accepts any valid http(s) URL (operator-supplied).

  // Disable auth/storageState and bypass secrets on fork PRs before handoff.
  return {
    ok: true,
    url: url.toString(),
    provider: input.provider,
    source,
    protectionBypassSecretName: storageStateForPr(input.protectionBypassSecretName, {
      isFork: input.isFork,
    }),
    authStateSecretName: storageStateForPr(input.authStateSecretName, { isFork: input.isFork }),
  };
}
