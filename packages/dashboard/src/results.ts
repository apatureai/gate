import { parseEngineResult } from "@gate/engine";
import type { GateReviewResult } from "@gate/types";

/**
 * Stored-result loader for the dashboard finding browser (TRD §13, §8).
 *
 * The full `GateReviewResult` is an engine-owned artifact in object storage —
 * the Gate `runs` table holds only metadata/lineage (#69), never the critique
 * JSON. This is the seam the deployment wires to its object store (R2/S3): a
 * storage fetcher keyed by run id, behind which the loader applies the SAME
 * contract gate the engine response goes through (#46) so a renamed/removed
 * field surfaces as a typed parse error rather than a silent null-grade view.
 *
 * The fetcher is injected so the core stays storage-agnostic and testable; the
 * Next.js shell's `results.ts` is a thin consumer that binds the real client.
 */

/** What a stored result looks like coming out of object storage. */
export interface StoredResult {
  /** The raw result JSON (object or already-parsed value). */
  body: unknown;
  /**
   * The `x-schema-version` the result was stored under, so an older dashboard
   * degrades gracefully on a major-version bump instead of mis-parsing.
   */
  schemaVersion: string | null;
}

/**
 * Fetch the stored result for a run from object storage, or null when no object
 * exists yet (e.g. metadata row written but the engine artifact not landed, or
 * already expired/tombstoned). Implementations key the object by `runId`.
 */
export interface ResultStorage {
  fetch(runId: string): Promise<StoredResult | null>;
}

export type LoadRunResult =
  | { ok: true; result: GateReviewResult }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "schema_version_mismatch"; detail: string }
  | { ok: false; reason: "schema_parse_error"; issues: string[] };

/**
 * Load + validate the stored engine result for a run. Returns a discriminated
 * result so the page can show the right state: the finding browser on `ok`, a
 * "not available yet" state on `not_found`, and a neutral "result needs
 * attention" state (never a null-grade render) on a contract mismatch.
 */
export async function loadRunResult(storage: ResultStorage, runId: string): Promise<LoadRunResult> {
  const stored = await storage.fetch(runId);
  if (!stored) return { ok: false, reason: "not_found" };

  const parsed = parseEngineResult(stored.body, stored.schemaVersion);
  if (!parsed.ok) return parsed;
  return { ok: true, result: parsed.result };
}

/**
 * Build a {@link ResultStorage} over a signed-URL fetcher — the common object-
 * store shape: the deployment mints a short-lived GET URL for the run's result
 * object and this reads + JSON-parses it. A 404 (or a null URL) is `not_found`;
 * any other non-OK status throws so the page surfaces a real error rather than a
 * misleading empty state.
 *
 * `signUrl` returns the GET URL for a run's result object, or null when no such
 * object exists. `fetchImpl` defaults to global `fetch` and is injectable for
 * tests.
 */
export function createSignedUrlResultStorage(deps: {
  signUrl(runId: string): Promise<string | null>;
  fetchImpl?: typeof fetch;
}): ResultStorage {
  const doFetch = deps.fetchImpl ?? fetch;
  return {
    async fetch(runId: string): Promise<StoredResult | null> {
      const url = await deps.signUrl(runId);
      if (!url) return null;
      const res = await doFetch(url);
      if (res.status === 404 || res.status === 410) return null;
      if (!res.ok) {
        throw new Error(`result storage fetch failed: ${res.status}`);
      }
      const body: unknown = await res.json();
      const schemaVersion = res.headers.get("x-schema-version");
      return { body, schemaVersion };
    },
  };
}
