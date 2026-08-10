import { formatReviewDemoResult, runReviewDemo } from "./review-demo.js";

/**
 * `node packages/action/dist/review-demo-cli.js [outDir]` runs the Action
 * path's review orchestration against a recorded engine response and writes the
 * sticky comment, Check Run and annotated screenshots to `out/`.
 */
const result = await runReviewDemo({ outDir: process.argv[2] });
console.log(formatReviewDemoResult(result));
