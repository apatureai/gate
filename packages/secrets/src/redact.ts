/**
 * Log/trace redaction (TRD §8). Secrets, signed URLs, storage state, and
 * screenshot contents must never reach logs or traces. `redact()` deep-clones a
 * value, masking sensitive keys by name and sensitive strings by shape, so it
 * can wrap anything before it is logged.
 */
export const REDACTED = "[REDACTED]";

const SENSITIVE_KEY_PATTERNS: RegExp[] = [
  /private.?key/i,
  /webhook.?secret/i,
  /api.?key/i,
  /secret/i,
  /token/i,
  /password/i,
  /authorization/i,
  /protection.?bypass/i,
  /storage.?state/i,
  /signed.?url/i,
  /\bbypass\b/i,
];

const SIGNED_URL_QUERY = /[?&](x-amz-signature|signature|sig|token|access_token)=/i;

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((re) => re.test(key));
}

function looksLikeSignedUrl(value: string): boolean {
  return /^https?:\/\//i.test(value) && SIGNED_URL_QUERY.test(value);
}

function looksLikeImageData(value: string): boolean {
  return /^data:image\//i.test(value);
}

/** Return a redacted deep copy of `value` safe to log. */
export function redact(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === "string") {
    return looksLikeSignedUrl(value) || looksLikeImageData(value) ? REDACTED : value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    return value.map((item) => redact(item, seen));
  }
  if (value !== null && typeof value === "object") {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = isSensitiveKey(key) ? REDACTED : redact(val, seen);
    }
    return out;
  }
  return value;
}
