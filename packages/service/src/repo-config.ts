import { DEFAULT_CONFIG, loadDesignReviewConfig } from "@gate/config";
import { withRateLimitRetry } from "@gate/engine";
import type { NormalizedDesignReviewConfig } from "@gate/types";

const API_ROOT = "https://api.github.com";
const DEFAULT_CONFIG_PATH = ".designreview.yml";

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
      const url = `${API_ROOT}/repos/${owner}/${name}/contents/${path}?ref=${encodeURIComponent(ref)}`;
      const res = await send(url);
      if (res.status === 404) return DEFAULT_CONFIG;
      if (!res.ok) throw new Error(`fetch .designreview.yml failed: ${res.status}`);

      const raw = (await res.json()) as RawContentFile | RawContentFile[];
      if (Array.isArray(raw)) return DEFAULT_CONFIG;
      return loadDesignReviewConfig(decodeContent(raw));
    },
  };
}
