import type { GateReviewResult } from "@gate/types";
import type { FastifyInstance } from "fastify";

/**
 * Stable annotated-screenshot route (TRD §7.1, §15.4/§15.5).
 *
 * PR comments reference a permanent app route `/i/<finding_id>.png`, never a raw
 * expiring object URL — so historical comments never 404. The route 302s to a
 * freshly-signed object URL each request, and serves a 410 tombstone once the
 * retention window (`expiresAt = receivedAt + screenshotRetentionSeconds`) has
 * passed. Gate owns this registry; the engine owns the bucket.
 */
export interface ScreenshotRecord {
  findingId: string;
  /** Object key/reference in engine-owned storage; re-signed on each request. */
  objectKey: string;
  /** Epoch ms after which the screenshot is gone (410). */
  expiresAt: number;
}

export interface ScreenshotRegistry {
  lookup(findingId: string): Promise<ScreenshotRecord | null>;
}

export interface SignedUrlProvider {
  /** Mint a fresh signed URL for the object (engine-owned bucket). */
  sign(objectKey: string): Promise<string>;
}

export interface ScreenshotRouteOptions {
  registry: ScreenshotRegistry;
  signer: SignedUrlProvider;
  /** Injectable clock for tests. */
  now?: () => number;
}

/** Register `GET /i/:id.png` on the Fastify app. */
export function registerScreenshotRoute(app: FastifyInstance, options: ScreenshotRouteOptions): void {
  const now = options.now ?? Date.now;
  app.get<{ Params: { id: string } }>("/i/:id.png", async (request, reply) => {
    const record = await options.registry.lookup(request.params.id);
    if (!record) {
      return reply.code(404).send({ error: "not_found" });
    }
    if (now() >= record.expiresAt) {
      // 410 tombstone (not a broken 302) once retention has passed.
      return reply.code(410).send({ error: "expired", message: "screenshot retention window has passed" });
    }
    const url = await options.signer.sign(record.objectKey);
    return reply.code(302).header("location", url).send();
  });
}

/** The stable, comment-safe URL for a finding's annotated screenshot. */
export function stableScreenshotUrl(baseUrl: string, findingId: string): string {
  return `${baseUrl.replace(/\/$/, "")}/i/${findingId}.png`;
}

/** Gate-owned run URL built from the runs record (never the engine's URL). */
export function buildRunUrl(baseUrl: string, runId: string): string {
  return `${baseUrl.replace(/\/$/, "")}/runs/${runId}`;
}

/**
 * Build the screenshot registry records for a completed review, stamping each
 * with the retention deadline from the engine result.
 */
export function buildScreenshotRecords(
  result: GateReviewResult,
  receivedAtMs: number,
): ScreenshotRecord[] {
  const expiresAt = receivedAtMs + result.screenshotRetentionSeconds * 1000;
  return result.artifacts.annotatedScreenshots.map((shot) => ({
    findingId: shot.findingId,
    objectKey: shot.url,
    expiresAt,
  }));
}
