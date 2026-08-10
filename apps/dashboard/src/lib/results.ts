import {
  createSignedUrlResultStorage,
  createTemplateResultUrlSigner,
  loadRunResult as loadRunResultCore,
} from "@gate/dashboard";
import type { GateReviewResult } from "@gate/types";
import { env } from "@/lib/env";

/**
 * App-side binding of the core result loader (`@gate/dashboard`
 * `loadRunResult` + `createSignedUrlResultStorage`). The full `GateReviewResult`
 * is an engine-owned object-storage artifact (the `runs` table holds only
 * metadata, #69); the core fetches the result JSON behind a signed URL and runs
 * it through the engine contract gate (#46) so a schema mismatch can never
 * render as a null-grade view.
 *
 * This module owns only the object-storage seam: resolving the signed GET URL
 * for a run's result object. If `GATE_RESULT_OBJECT_URL_TEMPLATE` is unset, the
 * page shows the safe "not available yet" state. The page contract stays
 * `GateReviewResult | null`: a contract mismatch is logged server-side and
 * surfaced as null (the safe state), never raw.
 */

const storage = createSignedUrlResultStorage({
  signUrl: createTemplateResultUrlSigner(env.resultObjectUrlTemplate()),
});

export async function loadRunResult(runId: string): Promise<GateReviewResult | null> {
  const res = await loadRunResultCore(storage, runId);
  if (res.ok) return res.result;
  if (res.reason !== "not_found") {
    // A configured store returned a contract-incompatible object. Surface the
    // safe "not available" state, but log so the stale-result alarm can fire.
    console.error(`loadRunResult(${runId}): ${res.reason}`, "detail" in res ? res.detail : res.issues);
  }
  return null;
}
