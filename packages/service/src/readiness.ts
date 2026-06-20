/**
 * Re-export of the shared readiness poll (moved to `@gate/engine`, #70 Part 1).
 * Kept here so App-path imports (`./readiness.js`) and `@gate/service`'s public
 * surface are unchanged. The App path uses the default strict-200 predicate; the
 * Action path passes the wider Playwright set + `abortOnChildExit`.
 */
export { READINESS_CEILING_MS, waitForReadiness } from "@gate/engine";
export type { ReadinessResult, ReadinessOptions } from "@gate/engine";
