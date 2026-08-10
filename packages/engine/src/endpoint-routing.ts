import { createHttpEngineTransport } from "./http.js";
import type { EngineTransport } from "./jobs.js";

/**
 * Per-account engine endpoint routing (TRD §6, §8, §15.5; ARCHITECTURE §3/§4 D3).
 *
 * Enterprise accounts can run `judgment-engine` in their own VPC so screenshots
 * (real staging PII) never leave their cloud. `engineEndpoint` is **Gate-internal
 * routing**, never a `GateReviewRequest` field. There is NO silent fallback to
 * the hosted engine: an in-VPC account's transport targets only the in-VPC
 * endpoint, so an outage surfaces an explicit error/not-reviewed and never leaks
 * data to the hosted engine. (No BYOK: Apature manages model serving; in-VPC
 * only relocates where the engine runs.)
 */
export interface EngineAccountRouting {
  /** Decrypted per-account in-VPC endpoint (from the KMS-encrypted config), or null/absent for hosted. */
  engineEndpoint?: string | null;
}

export interface ResolvedEngineRoute {
  endpoint: string;
  inVpc: boolean;
  /** True for in-VPC: never fall back to hosted on failure. */
  noFallback: boolean;
}

/** Resolve which engine endpoint an account's jobs route to. */
export function resolveEngineRoute(
  account: EngineAccountRouting,
  hostedEndpoint: string,
): ResolvedEngineRoute {
  if (account.engineEndpoint && account.engineEndpoint.trim() !== "") {
    return { endpoint: account.engineEndpoint.trim(), inVpc: true, noFallback: true };
  }
  return { endpoint: hostedEndpoint, inVpc: false, noFallback: false };
}

export interface AccountEngineTransportOptions {
  hostedEndpoint: string;
  apiKey?: string;
  hmacSecret?: string;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Build the engine transport for an account, routed to its in-VPC endpoint when
 * configured. The transport targets exactly one base URL, and there is no path that
 * retries against the hosted engine, so data residency holds even on outage.
 */
export function createAccountEngineTransport(
  account: EngineAccountRouting,
  options: AccountEngineTransportOptions,
): { transport: EngineTransport; route: ResolvedEngineRoute } {
  const route = resolveEngineRoute(account, options.hostedEndpoint);
  const transport = createHttpEngineTransport({
    baseUrl: route.endpoint,
    apiKey: options.apiKey,
    hmacSecret: options.hmacSecret,
    requestTimeoutMs: options.requestTimeoutMs,
    fetchImpl: options.fetchImpl,
  });
  return { transport, route };
}
