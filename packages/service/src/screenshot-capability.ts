import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Pure screenshot URL/capability helpers for dashboard consumers. Kept outside
 * the `@gate/service` barrel so the Next.js dashboard can import these without
 * pulling in Fastify, delivery, or native screenshot annotation dependencies.
 */

export interface ScreenshotCapability {
  /** Bound to the collision-safe artifact id + tenant + repo (#71), never findingId. */
  artifactId: string;
  installationId: string;
  owner: string;
  name: string;
  /** Expiry epoch ms. */
  exp: number;
}

export type VerifyCapabilityResult =
  | { ok: true; capability: ScreenshotCapability }
  | { ok: false };

export function mintScreenshotCapability(cap: ScreenshotCapability, secret: string): string {
  const body = Buffer.from(JSON.stringify(cap)).toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

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
