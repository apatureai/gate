import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * HMAC-SHA256 auth for Gate -> engine requests (TRD §8, §15.2; ARCHITECTURE D4).
 *
 * Gate signs the canonical payload `${timestamp}.${installationId}.${body}` so
 * `installationId` is bound into the signature. The engine verifies before
 * processing and scopes all tenant storage to the *verified* installationId, so a
 * bug or compromise cannot misroute a review into another tenant's prefix. The
 * secret comes from the KMS-backed store (`@gate/secrets` `engineHmacSecret`).
 * HMAC chosen over JWT for MVP (no clock-skew/JWKS surface); short-lived JWT is
 * the M3 upgrade.
 */

export const SIGNATURE_HEADER = "x-gate-signature";
export const INSTALLATION_HEADER = "x-gate-installation";
export const TIMESTAMP_HEADER = "x-gate-timestamp";

export interface SignatureHeaders {
  [INSTALLATION_HEADER]: string;
  [TIMESTAMP_HEADER]: string;
  [SIGNATURE_HEADER]: string;
}

function canonical(timestamp: string, installationId: string, body: string): string {
  return `${timestamp}.${installationId}.${body}`;
}

export function signEngineRequest(params: {
  body: string;
  installationId: string;
  secret: string;
  timestamp?: number;
}): SignatureHeaders {
  const ts = String(params.timestamp ?? Date.now());
  const mac = createHmac("sha256", params.secret)
    .update(canonical(ts, params.installationId, params.body))
    .digest("hex");
  return {
    [INSTALLATION_HEADER]: params.installationId,
    [TIMESTAMP_HEADER]: ts,
    [SIGNATURE_HEADER]: `sha256=${mac}`,
  };
}

export type VerifyFailureReason =
  | "missing_signature"
  | "missing_installation"
  | "signature_mismatch"
  | "timestamp_skew";

export type VerifyResult = { ok: true } | { ok: false; reason: VerifyFailureReason };

/**
 * Verify a signed request (engine-side helper). Constant-time compare; optional
 * timestamp-skew window guards against replay. The caller logs failures (never
 * the secret) and alerts.
 */
export function verifyEngineRequest(params: {
  body: string;
  installationId: string;
  timestamp: string;
  signature: string;
  secret: string;
  maxSkewMs?: number;
  now?: number;
}): VerifyResult {
  if (!params.installationId) return { ok: false, reason: "missing_installation" };
  if (!params.signature) return { ok: false, reason: "missing_signature" };

  const expected = createHmac("sha256", params.secret)
    .update(canonical(params.timestamp, params.installationId, params.body))
    .digest("hex");
  const provided = params.signature.startsWith("sha256=")
    ? params.signature.slice("sha256=".length)
    : params.signature;

  const expectedBuf = Buffer.from(expected, "hex");
  const providedBuf = Buffer.from(provided, "hex");
  if (expectedBuf.length !== providedBuf.length || !timingSafeEqual(expectedBuf, providedBuf)) {
    return { ok: false, reason: "signature_mismatch" };
  }

  if (params.maxSkewMs !== undefined) {
    const now = params.now ?? Date.now();
    const ts = Number(params.timestamp);
    // A non-numeric/empty timestamp must FAIL the skew check, not silently pass
    // it (every NaN comparison is false). Mirrors the engine-side verifier.
    if (!Number.isFinite(ts) || Math.abs(now - ts) > params.maxSkewMs) {
      return { ok: false, reason: "timestamp_skew" };
    }
  }
  return { ok: true };
}
