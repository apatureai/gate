import { DEFAULT_CONFIG, detectComponentLibraryIds, loadDesignReviewConfig } from "@gate/config";
import { withRateLimitRetry } from "@gate/engine";
import type { NormalizedDesignReviewConfig } from "@gate/types";
import { GITHUB_API_ROOT } from "./github-api.js";

const DEFAULT_CONFIG_PATH = ".gate.yml";

export interface RepoConfigClient {
  loadConfig(owner: string, name: string, ref: string): Promise<NormalizedDesignReviewConfig>;
}

interface RawContentFile {
  type?: string;
  encoding?: string;
  content?: string | null;
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function decodeContent(raw: RawContentFile): string | null {
  if (raw.type !== "file" || raw.encoding !== "base64" || !raw.content) return null;
  return Buffer.from(raw.content.replace(/\s/g, ""), "base64").toString("utf8");
}

export function createGitHubRepoConfigClient(
  token: string,
  fetchImpl: typeof fetch = fetch,
  configPath = DEFAULT_CONFIG_PATH,
): RepoConfigClient {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "apature-gate",
  };
  const path = encodePath(configPath);
  const send = (url: string): Promise<Response> => withRateLimitRetry(() => fetchImpl(url, { headers }));

  return {
    async loadConfig(owner, name, ref) {
      const url = `${GITHUB_API_ROOT}/repos/${owner}/${name}/contents/${path}?ref=${encodeURIComponent(ref)}`;
      const res = await send(url);
      if (res.status === 404) return DEFAULT_CONFIG;
      if (!res.ok) throw new Error(`fetch .gate.yml failed: ${res.status}`);

      const raw = (await res.json()) as RawContentFile | RawContentFile[];
      if (Array.isArray(raw)) return DEFAULT_CONFIG;
      return loadDesignReviewConfig(decodeContent(raw));
    },
  };
}

/**
 * Which component libraries the repository under review is built with, read
 * from its `package.json` at a ref.
 *
 * The App path has no checkout, and neither does the critique engine, so this
 * one GitHub read is the only way the engine's deep prompt can be told to judge
 * spacing against MUI's scale or to expect Radix's ARIA semantics. It is the
 * hosted counterpart of the Action reading the file off disk.
 *
 * Never throws and never blocks a review. Component-library detection is
 * grounding, not a precondition: a missing manifest, a private-repo permission
 * change, a rate limit or a malformed file all mean the same thing here, which
 * is a review grounded on tokens and brand, exactly as before this existed.
 * `loadConfig` above is deliberately stricter, because a `.gate.yml` that
 * cannot be read would silently change what the review DOES.
 */
export interface ComponentLibraryClient {
  detect(owner: string, name: string, ref: string): Promise<string[]>;
}

export function createGitHubComponentLibraryClient(
  token: string,
  fetchImpl: typeof fetch = fetch,
  manifestPath = "package.json",
): ComponentLibraryClient {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "apature-gate",
  };
  const path = encodePath(manifestPath);

  return {
    async detect(owner, name, ref) {
      try {
        const url = `${GITHUB_API_ROOT}/repos/${owner}/${name}/contents/${path}?ref=${encodeURIComponent(ref)}`;
        const res = await withRateLimitRetry(() => fetchImpl(url, { headers }));
        if (!res.ok) return [];
        const raw = (await res.json()) as RawContentFile | RawContentFile[];
        if (Array.isArray(raw)) return [];
        return detectComponentLibraryIds(decodeContent(raw));
      } catch {
        return [];
      }
    },
  };
}
