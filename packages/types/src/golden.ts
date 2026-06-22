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
 *
 * Resolved lazily (function, not a top-level const): `@gate/types` is imported
 * by the dashboard app for plain types/helpers (e.g. `deriveArtifactId`), and a
 * top-level `new URL(..., import.meta.url)` evaluated at import time breaks the
 * Next.js bundler (`ERR_INVALID_ARG_TYPE` from `fileURLToPath`). Keeping it
 * lazy makes merely importing the barrel side-effect-free — only the
 * test/mock-engine callers that actually read the fixture pay for it.
 */
export function goldenReviewResultPath(): string {
  return fileURLToPath(new URL("../fixtures/gate-review-result.golden.json", import.meta.url));
}

/**
 * Load the golden `GateReviewResult`. Until the Zod runtime parser lands (#46),
 * callers get the typed shape directly; #46 will validate it on the way through.
 */
export function loadGoldenReviewResult(): GateReviewResult {
  return JSON.parse(readFileSync(goldenReviewResultPath(), "utf8")) as GateReviewResult;
}
