import type { CheckRun } from "./check-run.js";

const SUMMARY_LIMIT = 1_800;

function capText(text: string, limit = SUMMARY_LIMIT): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 20)).trimEnd()}\n[truncated]`;
}

function configIssues(error: unknown): string[] | null {
  if (
    error instanceof Error &&
    error.name === "ConfigValidationError" &&
    "issues" in error &&
    Array.isArray(error.issues)
  ) {
    return error.issues.map((issue) => String(issue));
  }
  return null;
}

/**
 * Gate ships no critique engine, so "the workflow never told Gate where the
 * engine is" is the most likely first-run state of every new installation. It is
 * a setup problem with a fix, not an outage, and it is reported as one: the
 * missing variables are named, and the summary says how to get an engine rather
 * than promising a retry that cannot help.
 */
export function engineNotConfiguredCheckRun(missing: readonly string[]): CheckRun {
  return {
    name: "Apature Gate",
    conclusion: "neutral",
    title: "Engine not configured",
    summary: capText(
      "Gate had nothing to send this PR to, so no review ran. **This is not a pass.**\n\n" +
        `Set ${missing.map((name) => `\`${name}\``).join(" and ")} on the workflow.\n\n` +
        "Gate judges nothing on its own: it resolves the preview, hands it to a critique engine, " +
        "and publishes what comes back. Run your own engine with " +
        "[apatureai/verdict](https://github.com/apatureai/verdict) and point these variables at it; " +
        "the Gate README has the exact commands.",
    ),
  };
}

export function setupFailureCheckRun(error: unknown, surface: "Action" | "App" = "Action"): CheckRun {
  const issues = configIssues(error);
  if (issues) {
    return {
      name: "Apature Gate",
      conclusion: "neutral",
      title: "Config invalid",
      summary: capText(`The .gate.yml file is invalid, so Gate skipped this review.\n\n${issues.map((issue) => `- ${issue}`).join("\n")}`),
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  return {
    name: "Apature Gate",
    conclusion: "neutral",
    title: `${surface} setup failed`,
    summary: capText(`Gate could not start this review before contacting the engine.\n\n${message}`),
  };
}
