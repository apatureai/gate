import { createSignedUrlResultStorage, loadRunResult as loadRunResultCore } from "@gate/dashboard";
import type { GateReviewResult } from "@gate/types";

/**
 * App-side binding of the core result loader (`@gate/dashboard`
 * `loadRunResult` + `createSignedUrlResultStorage`). The full `GateReviewResult`
 * is an engine-owned object-storage artifact (the `runs` table holds only
 * metadata, #69); the core fetches the result JSON behind a signed URL and runs
 * it through the engine contract gate (#46) so a schema mismatch can never
 * render as a null-grade view.
 *
 * This module owns only the object-storage seam: minting the signed GET URL for
 * a run's result object. Until that store is provisioned (env-gated go-live,
 * #64), `signResultUrl` returns null and the page shows the "not available yet"
 * state. The page contract stays `GateReviewResult | null`: a contract mismatch
 * is logged server-side and surfaced as null (the safe state), never raw.
 */

/**
 * Mint a short-lived GET URL for a run's stored result object, or null when no
 * object store is configured / no object exists. Bind this to R2/S3 (key by run
 * id) at go-live.
 */
async function signResultUrl(_runId: string): Promise<string | null> {
  // TODO(go-live, #64): sign a GET URL for the result object (R2/S3) by run id.
  return null;
}

const storage = createSignedUrlResultStorage({ signUrl: signResultUrl });

export async function loadRunResult(runId: string): Promise<GateReviewResult | null> {
  const res = await loadRunResultCore(storage, runId);
  if (res.ok) return res.result;
  if (res.reason !== "not_found") {
    // A configured store returned a contract-incompatible object — surface the
    // safe "not available" state, but log so the stale-result alarm can fire.
    console.error(`loadRunResult(${runId}): ${res.reason}`, "detail" in res ? res.detail : res.issues);
  }
  return null;
}
