import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Signed dashboard session (TRD §13). HMAC token carrying the user and the
 * installation ids they may access, so every dashboard request is scoped without
 * a DB lookup. Mirrors the engine/feedback HMAC pattern.
 */
export interface DashboardSession {
  userId: number;
  login: string;
  installationIds: number[];
  exp: number;
}

export function mintSession(session: DashboardSession, secret: string): string {
  const body = Buffer.from(JSON.stringify(session)).toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export type VerifySessionResult =
  | { ok: true; session: DashboardSession }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

export function verifySession(
  token: string,
  secret: string,
  now: number = Date.now(),
): VerifySessionResult {
  const [body, sig] = token.split(".");
  if (!body || !sig) return { ok: false, reason: "malformed" };
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "bad_signature" };
  let session: DashboardSession;
  try {
    session = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as DashboardSession;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof session.exp !== "number" || now > session.exp) return { ok: false, reason: "expired" };
  return { ok: true, session };
}
