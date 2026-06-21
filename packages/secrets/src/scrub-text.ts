/**
 * Free-text secret scrubber (#78). `redact()` (redact.ts) masks STRUCTURED data —
 * sensitive object keys, signed-URL strings, image data — but cannot sanitize an
 * arbitrary blob of free text such as a preview-command's stdout/stderr tail.
 * That tail is attacker-influenced (fork PR code) and may print the user's OWN
 * secrets, so before any of it reaches a PR Check Run it must have known secret
 * SHAPES masked. (Gate's own secrets are already kept out of the child by the
 * env allowlist; this guards against secrets the previewed app itself emits.)
 *
 * Conservative by design: mask high-confidence secret shapes + explicit
 * `key=value` secret assignments, and keep the rest readable for DX. Pure, no I/O.
 */

interface TextSecretPattern {
  kind: string;
  re: RegExp;
  /** When set, replace only this capture group (e.g. the value of key=value). */
  group?: number;
}

function mask(kind: string): string {
  return `[REDACTED ${kind}]`;
}

// Ordered most-specific first. All global + multiline where relevant.
const PATTERNS: TextSecretPattern[] = [
  // PEM private-key blocks (multiline).
  { kind: "private-key", re: /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g },
  // JWTs: header.payload.signature, base64url.
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{6,}\.eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g },
  // Provider tokens with distinctive prefixes.
  { kind: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g },
  { kind: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: "llm-key", re: /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g },
  { kind: "aws-access-key-id", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  // Authorization: Bearer <token> / Basic <token>.
  { kind: "auth-header", re: /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi },
  // URL signature query params (matches redact.ts SIGNED_URL_QUERY family); mask
  // the value (group 2), keep the param name (group 1).
  { kind: "signed-url", re: /[?&](?:x-amz-signature|signature|sig|access_token|token)=([^&\s'"]+)/gi, group: 1 },
  // Explicit secret assignments: API_KEY=..., AWS_SECRET_ACCESS_KEY=..., password: "...".
  // The key may be an UPPER_SNAKE / camel identifier that CONTAINS a secret word
  // (so `\b` word-boundaries won't do — `AWS_SECRET_ACCESS_KEY` has none around
  // "SECRET"). The value lookahead avoids re-masking an already-masked token.
  {
    kind: "secret",
    re: /\b[A-Za-z0-9_]*(?:secret|token|password|passwd|pwd|api[_-]?key|access[_-]?key|client[_-]?secret)[A-Za-z0-9_]*\s*[:=]\s*['"]?(?!\[REDACTED)([^\s'"&]{6,})/gi,
    group: 1,
  },
];

/**
 * Mask known secret shapes in free text. Returns the text with each match
 * replaced by `[REDACTED <kind>]` (for `group` patterns, only the secret value).
 */
export function scrubText(text: string): string {
  let out = text;
  for (const p of PATTERNS) {
    out = out.replace(p.re, (full, ...args) => {
      if (p.group === undefined) return mask(p.kind);
      // args = [g1, g2, ..., offset, string]; capture groups are 1-based.
      const captured = args[p.group - 1] as string | undefined;
      if (captured === undefined) return mask(p.kind);
      return full.replace(captured, mask(p.kind));
    });
  }
  return out;
}

/**
 * Scrub free text AND length-cap it to the LAST `maxLen` chars (an error tail is
 * most informative at its end). Prepends an ellipsis marker when truncated.
 * Scrub first, then cap, so a secret straddling the cut can't survive.
 */
export function scrubTail(text: string, maxLen = 2000): string {
  const scrubbed = scrubText(text);
  if (scrubbed.length <= maxLen) return scrubbed;
  return `…(truncated)\n${scrubbed.slice(scrubbed.length - maxLen)}`;
}
