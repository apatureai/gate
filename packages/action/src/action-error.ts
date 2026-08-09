/**
 * Human-readable rendering of a fatal Action error.
 *
 * The entrypoint never rethrows — the Check Run, not the exit code, is the gate
 * (#21) — so this log line is the *only* thing an operator sees when the run
 * dies before anything can be published. A bare stack trace from `readFileSync`
 * or a `401` is not diagnosable, so the common wiring mistakes get a second
 * line naming the input that is wrong.
 */
export function formatActionError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const hint = hintFor(message);
  return hint ? `Apature Gate action error: ${message}\n  ${hint}` : `Apature Gate action error: ${message}`;
}

function hintFor(message: string): string | null {
  if (/failed: 40[13]$/.test(message)) {
    return "GitHub rejected the token. Set INPUT_GITHUB_TOKEN (or GITHUB_TOKEN) to a token with checks:write and pull-requests:write. Nothing was published; the run still exits 0 so the pull request is not failed.";
  }
  if (/failed: 404$/.test(message)) {
    return "GitHub returned 404. Check GITHUB_REPOSITORY and the pull request number in GITHUB_EVENT_PATH, and that the token can see the repository.";
  }
  if (message.includes("missing GitHub Action context")) {
    return "Set GITHUB_REPOSITORY (owner/repo) and GITHUB_EVENT_PATH (a pull_request event payload).";
  }
  if (message.startsWith("EISDIR")) {
    return "GITHUB_EVENT_PATH is a directory. On Docker Desktop a bind mount of a path the daemon cannot share (for example /tmp on macOS) silently becomes an empty directory — mount the payload from a shared path such as the repository working directory.";
  }
  if (message.startsWith("ENOENT")) {
    return "GITHUB_EVENT_PATH does not exist inside the container. Check the bind mount.";
  }
  return null;
}
