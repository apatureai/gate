import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { FeedbackEventType } from "@gate/types";

/**
 * One-time HMAC tokens for feedback votes (TRD §7.1, §8). Every vote is a POST
 * behind a single-use, signed, expiring token, so unfurlers/scanners/prefetchers
 * (which only issue GETs) can never label a finding. The token carries the full
 * event identity so the POST handler can record it without trusting query input.
 */
export interface FeedbackVotePayload {
  /** Token id for single-use enforcement. */
  jti: string;
  type: FeedbackEventType;
  installationId: string;
  owner: string;
  name: string;
  prNumber: number;
  headSha: string;
  findingId: string | null;
  /** Expiry epoch ms. */
  exp: number;
}

export function mintFeedbackToken(
  payload: Omit<FeedbackVotePayload, "jti">,
  secret: string,
  jti: string = randomUUID(),
): string {
  const body = Buffer.from(JSON.stringify({ ...payload, jti })).toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export type VerifyTokenResult =
  | { ok: true; payload: FeedbackVotePayload }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

export function verifyFeedbackToken(
  token: string,
  secret: string,
  now: number = Date.now(),
): VerifyTokenResult {
  const [body, sig] = token.split(".");
  if (!body || !sig) return { ok: false, reason: "malformed" };

  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "bad_signature" };

  let payload: FeedbackVotePayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as FeedbackVotePayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof payload.exp !== "number" || now > payload.exp) return { ok: false, reason: "expired" };
  return { ok: true, payload };
}

/** Single-use enforcement: consume returns false if the jti was already used. */
export interface ConsumedTokenStore {
  consume(jti: string): Promise<boolean>;
}

export function createInMemoryConsumedStore(): ConsumedTokenStore {
  const used = new Set<string>();
  return {
    async consume(jti) {
      if (used.has(jti)) return false;
      used.add(jti);
      return true;
    },
  };
}
