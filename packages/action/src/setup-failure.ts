import { setupFailureCheckRun } from "@gate/delivery";
import type { CheckRun } from "@gate/delivery";

export interface SetupFailurePublisher {
  headSha: string;
  getCurrentHeadSha(): Promise<string>;
  publishCheckRun(run: CheckRun): Promise<void>;
}

export async function publishSetupFailureCheckRun(
  error: unknown,
  publisher: SetupFailurePublisher,
): Promise<"published" | "stale"> {
  if ((await publisher.getCurrentHeadSha()) !== publisher.headSha) return "stale";
  await publisher.publishCheckRun(setupFailureCheckRun(error));
  return "published";
}

export { setupFailureCheckRun };
