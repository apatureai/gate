import type { CheckRun } from "./check-run.js";
import { sanitizeCodeSpan } from "./sanitize.js";

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

/** How a malformed endpoint is described to the operator. Structural, so `@gate/secrets` owns the detection and this owns the wording. */
export interface MalformedEndpointFacts {
  /** The variable the value arrived under, canonical or deprecated. */
  variableName: string;
  /** The value as configured. */
  value: string;
  /** One clause naming what is wrong with it. */
  reason: string;
  /** A corrected form, when one could be derived. */
  suggestion: string | null;
}

const ENDPOINT_DISPLAY_LIMIT = 200;

/**
 * Render a configured value inside a code span without letting it escape one.
 *
 * Deliberately not `sanitizeDisplayText`: that one defangs `https://` with a
 * zero-width space, which is right for engine prose and wrong here, because the
 * whole point of printing the value is that the operator can compare it to what
 * they pasted, and the suggestion next to it has to survive being copied. So the
 * transform is the minimum that keeps a code span closed: no control characters,
 * no newlines, no backticks, and a length cap. That is `sanitizeCodeSpan`, which
 * this named it before the sticky comment needed the same primitive for routes.
 */
function codeSpan(value: string): string {
  return sanitizeCodeSpan(value, ENDPOINT_DISPLAY_LIMIT);
}

/**
 * A configured endpoint Gate cannot send a job to.
 *
 * This is the same class of problem as an unset endpoint, and until it was
 * checked here it was reported as the opposite: the value passed the blank test,
 * failed at `fetch`, and arrived in `classifyEngineFailure` with no HTTP status,
 * so it was published as "temporarily unavailable ... Gate will retry" on every
 * push, forever. A bare hostname is not an outage. It is one variable, and the
 * summary shows the value it could not parse (an endpoint is an address, not a
 * credential) next to a form that would work.
 */
export function engineEndpointInvalidCheckRun(facts: MalformedEndpointFacts): CheckRun {
  const suggestion = facts.suggestion
    ? `Did you mean ${codeSpan(facts.suggestion)}?\n\n`
    : "";
  return {
    name: "Apature Gate",
    conclusion: "neutral",
    title: "Engine endpoint invalid",
    summary: capText(
      `Gate could not use the engine endpoint it was given, so no review ran. **This is not a pass.**\n\n` +
        `\`${facts.variableName}\` is set to ${codeSpan(facts.value)}, and ${facts.reason}.\n\n` +
        suggestion +
        "An endpoint has to be an absolute http or https URL, scheme included, pointing at the " +
        "root of the critique service: Gate appends `/jobs` to it. A hosting dashboard that shows " +
        "you a bare hostname is showing you the host, not the URL.\n\n" +
        "This one does not clear by itself: the next push reads the same value, so Gate is not " +
        "promising a retry that would fix it.",
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
