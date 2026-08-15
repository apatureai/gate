import { formatLiveReviewResult, LiveReviewConfigError, runLiveReview } from "./live-review.js";

/**
 * `node packages/action/dist/live-review-cli.js [outDir]` runs the Action path's
 * review orchestration against the critique service in `GATE_ENGINE_ENDPOINT`,
 * capturing a page the sandbox supervisor really starts.
 *
 * Exit codes: 0 the chain worked, 2 no engine is configured, 1 anything else.
 */
try {
  const result = await runLiveReview({ outDir: process.argv[2] });
  console.log(formatLiveReviewResult(result));
} catch (error) {
  if (error instanceof LiveReviewConfigError) {
    console.error(error.message);
    process.exit(2);
  }
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
}
