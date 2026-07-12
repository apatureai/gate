/**
 * Sanitize engine-supplied display text before GitHub publication (gate #156).
 *
 * The page-health footnote is engine-owned aggregate prose today, but Gate treats
 * it as UNTRUSTED display text on principle: a future or compromised producer must
 * not be able to inject a link, an HTML block, an `@mention`, or unbounded content
 * into a Gate comment. The transform is one-way and lossy on purpose - it favors
 * safety over fidelity.
 */

const DEFAULT_MAX_LENGTH = 500;
/** Non-printable control chars (normal whitespace is handled by the collapse below). */
// eslint-disable-next-line no-control-regex -- intentionally matches control chars to strip them
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
/** Markdown/HTML metacharacters that could open a link, code span, table, or HTML. */
const MARKDOWN_META = /[\\`<>[\]()|]/g;
const ZERO_WIDTH = "\u200B";

/**
 * Normalize control characters, collapse ALL whitespace (so no block-level
 * construct - heading, table, HTML block - can be injected via newlines), cap the
 * length, escape Markdown/HTML metacharacters, and defang `@mentions` and bare
 * links. Returns safe single-line inline text.
 */
export function sanitizeDisplayText(text: string, maxLength = DEFAULT_MAX_LENGTH): string {
  let s = text.replace(CONTROL_CHARS, "").replace(/\s+/g, " ").trim();
  if (s.length > maxLength) s = `${s.slice(0, Math.max(0, maxLength - 1)).trimEnd()}\u2026`;
  return s
    .replace(MARKDOWN_META, (c) => `\\${c}`)
    .replace(/@/g, `@${ZERO_WIDTH}`) // neutralize @mentions
    .replace(/(https?):\/\//gi, `$1${ZERO_WIDTH}://`); // defang bare autolinks
}
