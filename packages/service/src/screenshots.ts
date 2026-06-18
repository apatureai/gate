import { createHmac, timingSafeEqual } from "node:crypto";
import type { GateReviewResult } from "@gate/types";
import type { FastifyInstance, FastifyRequest } from "fastify";

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
  findingId: string;
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
  lookup(findingId: string): Promise<ScreenshotRecord | null>;
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
  findingId: string;
  installationId: string;
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
      if (v.ok && v.capability.findingId === record.findingId && v.capability.installationId === record.installationId) {
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
    if (now() >= record.expiresAt) {
      return reply.code(410).send({ error: "expired", message: "screenshot retention window has passed" });
    }
    if (!(await isAuthorized(request, record))) {
      return reply.code(404).send({ error: "not_found" });
    }
    const url = await options.signer.sign(record.objectKey);
    return reply.code(302).header("location", url).send();
  });
}

/** The stable, comment-safe URL for a public finding's annotated screenshot. */
export function stableScreenshotUrl(baseUrl: string, findingId: string): string {
  return `${baseUrl.replace(/\/$/, "")}/i/${findingId}.png`;
}

/** Stable URL for a private artifact, carrying a short-lived capability token. */
export function capabilityScreenshotUrl(baseUrl: string, findingId: string, capability: string): string {
  return `${stableScreenshotUrl(baseUrl, findingId)}?cap=${encodeURIComponent(capability)}`;
}

/** Gate-owned run URL built from the runs record (never the engine's URL). */
export function buildRunUrl(baseUrl: string, runId: string): string {
  return `${baseUrl.replace(/\/$/, "")}/runs/${runId}`;
}

export interface ScreenshotOwnership {
  installationId: string;
  owner: string;
  name: string;
  visibility: ScreenshotVisibility;
}

/**
 * Build the screenshot registry records for a completed review, stamping the
 * retention deadline and the ownership/visibility scope used for authorization.
 */
export function buildScreenshotRecords(
  result: GateReviewResult,
  receivedAtMs: number,
  ownership: ScreenshotOwnership,
): ScreenshotRecord[] {
  const expiresAt = receivedAtMs + result.screenshotRetentionSeconds * 1000;
  return result.artifacts.annotatedScreenshots.map((shot) => ({
    findingId: shot.findingId,
    objectKey: shot.url,
    expiresAt,
    installationId: ownership.installationId,
    owner: ownership.owner,
    name: ownership.name,
    visibility: ownership.visibility,
  }));
}
