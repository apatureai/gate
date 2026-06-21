import type { GateReviewResult } from "@gate/types";

/**
 * Load the stored engine result for a run. The full `GateReviewResult` is an
 * engine-owned artifact in object storage (the `runs` table holds only metadata),
 * so this is the object-storage seam the deployment wires (R2/S3 client keyed by
 * run id). Until wired it returns null and the finding browser shows a
 * "result not yet available" state — the page + capability-URL wiring still build.
 */
export async function loadRunResult(_runId: string): Promise<GateReviewResult | null> {
  // TODO(go-live): fetch the result JSON from object storage by run id.
  return null;
}
