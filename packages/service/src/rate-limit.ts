// Rate-limit handling moved to the shared @gate/engine layer (used by both the
// Action and App GitHub clients). Re-exported here for existing importers.
export { isRateLimited, rateLimitDelayMs, withRateLimitRetry } from "@gate/engine";
export type { RateLimitRetryOptions } from "@gate/engine";
