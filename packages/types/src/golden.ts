import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { GateReviewResult } from "./review.js";

/**
 * Path to the golden `GateReviewResult` fixture (TRD §14).
 *
 * This single fixture is the shared boundary artifact: the engine serializer
 * test and Gate's mock engine both read it, so the mock cannot drift from the
 * live contract. Resolved relative to the compiled file (dist/golden.js ->
 * ../fixtures), so it works from the published package.
 */
export const GOLDEN_REVIEW_RESULT_PATH = fileURLToPath(
  new URL("../fixtures/gate-review-result.golden.json", import.meta.url),
);

/**
 * Load the golden `GateReviewResult`. Until the Zod runtime parser lands (#46),
 * callers get the typed shape directly; #46 will validate it on the way through.
 */
export function loadGoldenReviewResult(): GateReviewResult {
  return JSON.parse(readFileSync(GOLDEN_REVIEW_RESULT_PATH, "utf8")) as GateReviewResult;
}
