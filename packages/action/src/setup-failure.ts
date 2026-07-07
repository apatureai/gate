import { ConfigValidationError } from "@gate/config";
import type { CheckRun } from "@gate/delivery";

const SUMMARY_LIMIT = 1_800;

export interface SetupFailurePublisher {
  headSha: string;
  getCurrentHeadSha(): Promise<string>;
  publishCheckRun(run: CheckRun): Promise<void>;
}

function capText(text: string, limit = SUMMARY_LIMIT): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 20)).trimEnd()}\n[truncated]`;
}

export function setupFailureCheckRun(error: unknown): CheckRun {
  if (error instanceof ConfigValidationError) {
    const issues = error.issues.map((issue) => `- ${issue}`).join("\n");
    return {
      name: "Apature Gate",
      conclusion: "neutral",
      title: "Config invalid",
      summary: capText(`The .designreview.yml file is invalid, so Gate skipped this review.\n\n${issues}`),
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  return {
    name: "Apature Gate",
    conclusion: "neutral",
    title: "Action setup failed",
    summary: capText(`Gate could not start this review before contacting the engine.\n\n${message}`),
  };
}

export async function publishSetupFailureCheckRun(
  error: unknown,
  publisher: SetupFailurePublisher,
): Promise<"published" | "stale"> {
  if ((await publisher.getCurrentHeadSha()) !== publisher.headSha) return "stale";
  await publisher.publishCheckRun(setupFailureCheckRun(error));
  return "published";
}
