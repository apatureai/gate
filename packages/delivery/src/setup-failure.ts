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

export function setupFailureCheckRun(error: unknown, surface: "Action" | "App" = "Action"): CheckRun {
  const issues = configIssues(error);
  if (issues) {
    return {
      name: "Apature Gate",
      conclusion: "neutral",
      title: "Config invalid",
      summary: capText(`The .designreview.yml file is invalid, so Gate skipped this review.\n\n${issues.map((issue) => `- ${issue}`).join("\n")}`),
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
