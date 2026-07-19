/**
 * The GitHub REST API base URL.
 *
 * `https://api.github.com` was hardcoded, byte-identical, in app-github.ts,
 * github-pulls.ts, and repo-config.ts. Single-sourcing the base URL removes the
 * duplication and gives the one place to change it (e.g. a GitHub Enterprise
 * Server `.../api/v3` root) rather than three.
 */

/** The base URL for GitHub REST API calls. */
export const GITHUB_API_ROOT = "https://api.github.com";
