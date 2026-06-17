import type { GateReviewRequest, NormalizedDesignReviewConfig } from "@gate/types";

type PreviewProvider = GateReviewRequest["preview"]["provider"];

/** How a preview URL was discovered (TRD §4, Action path). */
export type DiscoverySource = "explicit" | "url_template" | "provider-bot" | "local";

export interface PreviewResolution {
  url: string;
  source: DiscoverySource;
  /** Provider attributed to the URL, for the engine request. */
  provider: PreviewProvider;
  /** Human-readable explanation of how the URL was chosen. */
  provenance: string;
}

export type PreviewDiscoveryOutcome =
  | { ok: true; resolution: PreviewResolution }
  | { ok: false; reason: string };

export interface ProviderComment {
  /** Comment author login, e.g. "vercel[bot]". */
  author: string;
  body: string;
}

export interface PreviewDiscoveryInput {
  /** Explicit `preview-url` action input. */
  explicitUrl?: string | null;
  prNumber: number;
  headSha: string;
  /** PR comments to scrape for a provider-bot preview link. */
  comments?: ProviderComment[];
  /** `preview-command` action input; presence enables the local-serve fallback. */
  previewCommand?: string | null;
  /** URL the local server is reachable at after the command runs. */
  localServeUrl?: string | null;
  /** Port for the default local URL when `localServeUrl` is not given. */
  localServePort?: number;
}

interface ProviderIdentity {
  /** Allowlisted bot logins that may post a trustworthy preview link. */
  botLogins: string[];
  /** Host suffixes the preview URL must match. */
  domainSuffixes: string[];
}

/**
 * Allowlisted provider identities. A provider-bot comment is only trusted when
 * the config names the provider (preview.source), the comment author is one of
 * these bot logins, AND the extracted URL's host matches a known domain. This is
 * why arbitrary free-text PR comments are never trusted as preview URLs.
 */
const PROVIDER_REGISTRY: Partial<Record<PreviewProvider, ProviderIdentity>> = {
  vercel: { botLogins: ["vercel[bot]"], domainSuffixes: ["vercel.app"] },
  netlify: { botLogins: ["netlify[bot]"], domainSuffixes: ["netlify.app"] },
  cloudflare: {
    botLogins: ["cloudflare-workers-and-pages[bot]", "cloudflare-pages[bot]"],
    domainSuffixes: ["pages.dev"],
  },
  render: { botLogins: ["render[bot]"], domainSuffixes: ["onrender.com"] },
};

function parseHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function hostMatches(host: string, suffixes: string[]): boolean {
  return suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function fillTemplate(template: string, prNumber: number, headSha: string): string {
  return template
    .replaceAll("{pr}", String(prNumber))
    .replaceAll("{sha}", headSha)
    .replaceAll("{short_sha}", headSha.slice(0, 7));
}

/** Extract the first allowlisted-domain URL from a comment body. */
function extractProviderUrl(body: string, identity: ProviderIdentity): string | null {
  const matches = body.match(/https?:\/\/[^\s)\]]+/gi) ?? [];
  for (const candidate of matches) {
    const url = parseHttpUrl(candidate);
    if (url && hostMatches(url.host, identity.domainSuffixes)) {
      return url.toString();
    }
  }
  return null;
}

/**
 * Resolve the rendered preview URL for the Action path, in priority order:
 * explicit input -> configured url_template -> allowlisted provider-bot comment
 * -> local build-and-serve. Returns the chosen URL with its source and
 * provenance, or an explanation of why nothing resolved.
 */
export function resolvePreviewUrl(
  input: PreviewDiscoveryInput,
  config: NormalizedDesignReviewConfig,
): PreviewDiscoveryOutcome {
  const attempted: string[] = [];

  // 1. Explicit input.
  if (input.explicitUrl && input.explicitUrl.trim() !== "") {
    const url = parseHttpUrl(input.explicitUrl);
    if (!url) {
      return { ok: false, reason: `explicit preview-url is not a valid http(s) URL: ${input.explicitUrl}` };
    }
    return {
      ok: true,
      resolution: {
        url: url.toString(),
        source: "explicit",
        provider: "explicit",
        provenance: "explicit preview-url input",
      },
    };
  }
  attempted.push("explicit (no input)");

  // 2. Configured url_template.
  if (config.preview.urlTemplate) {
    const filled = fillTemplate(config.preview.urlTemplate, input.prNumber, input.headSha);
    const url = parseHttpUrl(filled);
    if (!url) {
      return { ok: false, reason: `url_template produced an invalid URL: ${filled}` };
    }
    return {
      ok: true,
      resolution: {
        url: url.toString(),
        source: "url_template",
        provider: config.preview.source,
        provenance: `url_template "${config.preview.urlTemplate}" (pr=${input.prNumber})`,
      },
    };
  }
  attempted.push("url_template (not configured)");

  // 3. Provider-bot comment, only when the config names a known provider.
  const identity = PROVIDER_REGISTRY[config.preview.source];
  if (identity) {
    for (const comment of input.comments ?? []) {
      if (!identity.botLogins.includes(comment.author)) continue;
      const url = extractProviderUrl(comment.body, identity);
      if (url) {
        return {
          ok: true,
          resolution: {
            url,
            source: "provider-bot",
            provider: config.preview.source,
            provenance: `${comment.author} comment (host matches ${identity.domainSuffixes.join("/")})`,
          },
        };
      }
    }
    attempted.push(`provider-bot (${config.preview.source}: no allowlisted comment with a matching domain)`);
  } else {
    attempted.push(`provider-bot (source "${config.preview.source}" is not a known provider)`);
  }

  // 4. Local build-and-serve fallback.
  if (input.previewCommand && input.previewCommand.trim() !== "") {
    const localUrl = input.localServeUrl ?? `http://127.0.0.1:${input.localServePort ?? 3000}`;
    const url = parseHttpUrl(localUrl);
    if (!url) {
      return { ok: false, reason: `local-serve URL is invalid: ${localUrl}` };
    }
    return {
      ok: true,
      resolution: {
        url: url.toString(),
        source: "local",
        provider: "local",
        provenance: "local serve via preview-command",
      },
    };
  }
  attempted.push("local-serve (no preview-command)");

  return { ok: false, reason: `no preview URL found. Attempted: ${attempted.join("; ")}` };
}
