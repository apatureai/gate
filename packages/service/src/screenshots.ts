import { createHmac, timingSafeEqual } from "node:crypto";
import { deriveArtifactId, type ArtifactScope, type GateReviewResult } from "@gate/types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { SqlQuery } from "./review-window.js";

// Re-exported for App-path consumers (the registry + route live here); the
// derivation itself is shared in @gate/types so the dashboard derives the same id.
export { deriveArtifactId };
export type { ArtifactScope };

/**
 * Stable annotated-screenshot route (TRD §7.1, §8, §15.4-§15.6).
 *
 * PR comments reference a permanent app route `/i/<finding_id>.png`, never a raw
 * expiring object URL — so historical comments never 404. The route 302s to a
 * freshly-signed object URL each request and serves a 410 tombstone once the
 * retention window has passed. Gate owns this registry; the engine owns the
 * encrypted bucket.
 *
 * Authorization (#61): a finding ID is NOT an authorization boundary. Only
 * explicitly public artifacts are anonymous; private-repo artifacts require an
 * installation-scoped session OR a short-lived signed capability before Gate asks
 * the signer to mint a URL. Cross-installation access is denied without ever
 * calling the signer, and unauthorized/missing records return 404 without
 * disclosing object keys or tenant existence.
 */
export type ScreenshotVisibility = "public" | "private";

export interface ScreenshotRecord {
  /** Gate-generated collision-safe id; the stable-route + authorization key. */
  artifactId: string;
  /** Engine run-local finding id (reference/lineage only — not an auth key). */
  findingId: string;
  /** Owning run's head SHA (part of the artifact identity). */
  headSha: string;
  /** Object key/reference in engine-owned storage; re-signed on each request. */
  objectKey: string;
  /** Epoch ms after which the screenshot is gone (410). */
  expiresAt: number;
  /** Owning installation (tenant) — the authorization scope. */
  installationId: string;
  owner: string;
  name: string;
  /** Anonymous access is allowed only for "public" (e.g. consenting OSS). */
  visibility: ScreenshotVisibility;
}

export interface ScreenshotRegistry {
  /** Look up by the collision-safe artifact id (never the engine finding id). */
  lookup(artifactId: string): Promise<ScreenshotRecord | null>;
}

export interface SignedUrlProvider {
  /** Mint a fresh signed URL for the object (engine-owned bucket). */
  sign(objectKey: string): Promise<string>;
}

/** Authorizes a request against a private record (e.g. via a dashboard session). */
export interface ScreenshotAuthorizer {
  authorize(request: FastifyRequest, record: ScreenshotRecord): boolean | Promise<boolean>;
}

export interface ScreenshotRouteOptions {
  registry: ScreenshotRegistry;
  signer: SignedUrlProvider;
  /** Secret for verifying `?cap=` capability tokens on private artifacts. */
  capabilitySecret?: string;
  /** Session-based authorizer for private artifacts (installation-scoped). */
  authorizer?: ScreenshotAuthorizer;
  /** Injectable clock for tests. */
  now?: () => number;
}

// --- short-lived signed capability for private artifacts -------------------

export interface ScreenshotCapability {
  /** Bound to the collision-safe artifact id + tenant + repo (#71), never findingId. */
  artifactId: string;
  installationId: string;
  owner: string;
  name: string;
  /** Expiry epoch ms. */
  exp: number;
}

export function mintScreenshotCapability(cap: ScreenshotCapability, secret: string): string {
  const body = Buffer.from(JSON.stringify(cap)).toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export type VerifyCapabilityResult =
  | { ok: true; capability: ScreenshotCapability }
  | { ok: false };

export function verifyScreenshotCapability(
  token: string,
  secret: string,
  now: number = Date.now(),
): VerifyCapabilityResult {
  const [body, sig] = token.split(".");
  if (!body || !sig) return { ok: false };
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false };
  let capability: ScreenshotCapability;
  try {
    capability = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as ScreenshotCapability;
  } catch {
    return { ok: false };
  }
  if (typeof capability.exp !== "number" || now > capability.exp) return { ok: false };
  return { ok: true, capability };
}

// --- route -----------------------------------------------------------------

/** Register `GET /i/:id.png` with authorization (#61). */
export function registerScreenshotRoute(app: FastifyInstance, options: ScreenshotRouteOptions): void {
  const now = options.now ?? Date.now;

  const isAuthorized = async (request: FastifyRequest, record: ScreenshotRecord): Promise<boolean> => {
    if (record.visibility === "public") return true;
    // Private: a valid capability for THIS finding + installation, or a session.
    const cap = (request.query as { cap?: string } | undefined)?.cap;
    if (cap && options.capabilitySecret) {
      const v = verifyScreenshotCapability(cap, options.capabilitySecret, now());
      // Bind the capability to the artifact id + tenant + repo: a token for one
      // artifact can't authorize a collided finding id in another run/repo (#71).
      if (
        v.ok &&
        v.capability.artifactId === record.artifactId &&
        v.capability.installationId === record.installationId &&
        v.capability.owner === record.owner &&
        v.capability.name === record.name
      ) {
        return true;
      }
    }
    if (options.authorizer) return options.authorizer.authorize(request, record);
    return false;
  };

  app.get<{ Params: { id: string } }>("/i/:id.png", async (request, reply) => {
    const record = await options.registry.lookup(request.params.id);
    // 404 for missing OR unauthorized — never disclose object keys / tenant existence.
    if (!record) return reply.code(404).send({ error: "not_found" });
    if (!(await isAuthorized(request, record))) {
      return reply.code(404).send({ error: "not_found" });
    }
    if (now() >= record.expiresAt) {
      return reply.code(410).send({ error: "expired", message: "screenshot retention window has passed" });
    }
    const url = await options.signer.sign(record.objectKey);
    return reply.code(302).header("location", url).send();
  });
}

/** The stable, comment-safe URL for an annotated screenshot, keyed by artifact id. */
export function stableScreenshotUrl(baseUrl: string, artifactId: string): string {
  return `${baseUrl.replace(/\/$/, "")}/i/${artifactId}.png`;
}

/** Stable URL for a private artifact, carrying a short-lived capability token. */
export function capabilityScreenshotUrl(baseUrl: string, artifactId: string, capability: string): string {
  return `${stableScreenshotUrl(baseUrl, artifactId)}?cap=${encodeURIComponent(capability)}`;
}

/** Gate-owned run URL built from the runs record (never the engine's URL). */
export function buildRunUrl(baseUrl: string, runId: string): string {
  return `${baseUrl.replace(/\/$/, "")}/runs/${runId}`;
}

export interface ScreenshotOwnership {
  installationId: string;
  owner: string;
  name: string;
  /** Owning run's head SHA — part of the collision-safe artifact identity (#71). */
  headSha: string;
  visibility: ScreenshotVisibility;
}

/**
 * Build the screenshot registry records for a completed review, stamping the
 * collision-safe artifact id (#71), the retention deadline, and the ownership/
 * visibility scope used for authorization. Deterministic, so re-recording the
 * same review yields the same ids (idempotent).
 */
export function buildScreenshotRecords(
  result: GateReviewResult,
  receivedAtMs: number,
  ownership: ScreenshotOwnership,
): ScreenshotRecord[] {
  const expiresAt = receivedAtMs + result.screenshotRetentionSeconds * 1000;
  return result.artifacts.annotatedScreenshots.map((shot) => ({
    artifactId: deriveArtifactId({
      installationId: ownership.installationId,
      owner: ownership.owner,
      name: ownership.name,
      headSha: ownership.headSha,
      findingId: shot.findingId,
    }),
    findingId: shot.findingId,
    headSha: ownership.headSha,
    objectKey: shot.url,
    expiresAt,
    installationId: ownership.installationId,
    owner: ownership.owner,
    name: ownership.name,
    visibility: ownership.visibility,
  }));
}

// --- durable registry (Postgres) -------------------------------------------

/**
 * A registry that also persists/cleans records (#71). The `/i` read path looks up
 * by the unguessable artifact id and the route authorizes (visibility +
 * capability bound to artifact/tenant/repo, #61), so this table is deliberately
 * NOT under the default-deny tenant RLS (that would break anonymous-public reads
 * and capability-based private reads, both of which run with no tenant GUC).
 * Tenant safety comes from the high-entropy id + route authorization, and
 * writes/enumeration/cleanup are scoped by `installation_id` explicitly.
 */
export interface ScreenshotRegistryWriter extends ScreenshotRegistry {
  /** Idempotently persist records for a completed review (upsert on artifact id). */
  record(records: ScreenshotRecord[]): Promise<void>;
  /** Offboarding: drop a tenant's artifacts so `/i` 404s afterward. Returns count. */
  deleteForInstallation(installationId: string): Promise<number>;
  /** Retention sweep: drop artifacts whose retention elapsed. Returns count. */
  deleteExpired(beforeMs: number): Promise<number>;
}

/** In-memory registry for dev/tests (mirrors the upsert idempotency). */
export function createInMemoryScreenshotRegistry(): ScreenshotRegistryWriter & {
  records: Map<string, ScreenshotRecord>;
} {
  const records = new Map<string, ScreenshotRecord>();
  return {
    records,
    async lookup(artifactId) {
      return records.get(artifactId) ?? null;
    },
    async record(items) {
      for (const r of items) records.set(r.artifactId, r); // upsert on artifact id
    },
    async deleteForInstallation(installationId) {
      let n = 0;
      for (const [id, r] of records) {
        if (r.installationId === installationId) {
          records.delete(id);
          n += 1;
        }
      }
      return n;
    },
    async deleteExpired(beforeMs) {
      let n = 0;
      for (const [id, r] of records) {
        if (r.expiresAt <= beforeMs) {
          records.delete(id);
          n += 1;
        }
      }
      return n;
    },
  };
}

interface ArtifactRow {
  artifact_id: string;
  finding_id: string;
  head_sha: string;
  object_key: string;
  expires_at: string | null;
  installation_id: string | number;
  repo_owner: string;
  repo_name: string;
  visibility: ScreenshotVisibility;
}

function mapArtifactRow(r: ArtifactRow): ScreenshotRecord {
  return {
    artifactId: r.artifact_id,
    findingId: r.finding_id,
    headSha: r.head_sha,
    objectKey: r.object_key,
    expiresAt: r.expires_at ? new Date(r.expires_at).getTime() : Number.POSITIVE_INFINITY,
    installationId: String(r.installation_id),
    owner: r.repo_owner,
    name: r.repo_name,
    visibility: r.visibility,
  };
}

/** Postgres screenshot registry (durable; survives restart). */
export function createSqlScreenshotRegistry(query: SqlQuery): ScreenshotRegistryWriter {
  return {
    async lookup(artifactId) {
      const { rows } = await query<ArtifactRow>(
        `SELECT artifact_id, finding_id, head_sha, object_key, expires_at,
                installation_id, repo_owner, repo_name, visibility
           FROM screenshot_artifacts WHERE artifact_id = $1`,
        [artifactId],
      );
      return rows[0] ? mapArtifactRow(rows[0]) : null;
    },
    async record(items) {
      for (const r of items) {
        await query(
          `INSERT INTO screenshot_artifacts
             (artifact_id, installation_id, repo_owner, repo_name, head_sha,
              finding_id, object_key, visibility, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (artifact_id) DO UPDATE SET
             object_key = EXCLUDED.object_key,
             visibility = EXCLUDED.visibility,
             expires_at = EXCLUDED.expires_at`,
          [
            r.artifactId,
            r.installationId,
            r.owner,
            r.name,
            r.headSha,
            r.findingId,
            r.objectKey,
            r.visibility,
            Number.isFinite(r.expiresAt) ? new Date(r.expiresAt).toISOString() : null,
          ],
        );
      }
    },
    async deleteForInstallation(installationId) {
      const { rows } = await query<{ artifact_id: string }>(
        `DELETE FROM screenshot_artifacts WHERE installation_id = $1 RETURNING artifact_id`,
        [installationId],
      );
      return rows.length;
    },
    async deleteExpired(beforeMs) {
      const { rows } = await query<{ artifact_id: string }>(
        `DELETE FROM screenshot_artifacts WHERE expires_at IS NOT NULL AND expires_at <= $1 RETURNING artifact_id`,
        [new Date(beforeMs).toISOString()],
      );
      return rows.length;
    },
  };
}
