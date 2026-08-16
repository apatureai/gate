import {
  formatLiveReviewResult,
  LiveReviewConfigError,
  LiveReviewEndpointError,
  runLiveReview,
} from "./live-review.js";

/**
 * `node packages/action/dist/live-review-cli.js [outDir]` runs the Action path's
 * review orchestration against the critique service in `GATE_ENGINE_ENDPOINT`,
 * capturing a page the sandbox supervisor really starts.
 *
 * Exit codes: 0 the chain worked, 2 the engine is not usably configured (unset,
 * or set to something that is not a URL), 1 anything else. The two setup errors
 * share an exit code because they share a fix: correct one variable and re-run.
 */
try {
  const result = await runLiveReview({ outDir: process.argv[2] });
  console.log(formatLiveReviewResult(result));
} catch (error) {
  if (error instanceof LiveReviewConfigError || error instanceof LiveReviewEndpointError) {
    console.error(error.message);
    process.exit(2);
  }
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
}
