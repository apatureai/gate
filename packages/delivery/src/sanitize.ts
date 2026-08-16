/**
 * Sanitize engine-supplied display text before GitHub publication (gate #156).
 *
 * Everything Gate publishes on a pull request is Markdown, and every string that
 * reaches it from the engine or the model is UNTRUSTED: the model's prose derives
 * partly from the page text of the pull request under review, so the author of
 * that pull request has influence over it without controlling the engine at all.
 *
 * The threat here is not XSS. GitHub strips script and event handlers, so nothing
 * executes. The threat is FORGERY of Gate's own voice: a string that closes the
 * `<details>` block it was rendered inside, then opens a second
 * `## Apature Gate: design review` heading and a bold `✅ Ship` line, makes a
 * reviewer scrolling the comment see Gate approving the pull request. The
 * structure of the comment is the security boundary, so the transform below is
 * about Markdown structure, not about HTML alone.
 *
 * Three primitives, one for each position a string can land in:
 *   - `sanitizeDisplayText` for inline prose,
 *   - `sanitizeCodeSpan` for a value shown as code,
 *   - `safeLinkUrl` for anything that becomes a link destination.
 *
 * All three are one-way and lossy on purpose: they favour safety over fidelity.
 */

const DEFAULT_MAX_LENGTH = 500;
/** Non-printable control chars (normal whitespace is handled by the collapse below). */
// eslint-disable-next-line no-control-regex -- intentionally matches control chars to strip them
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
/**
 * Every metacharacter that can open a Markdown or HTML construct in INLINE
 * position: a link or image (`[ ] ( ) !`), a raw tag or autolink (`< >`), a code
 * span (`` ` ``), a table cell (`|`), emphasis or a forged bold verdict line
 * (`* _`), strikethrough (`~`), a heading (`#`), and the escape character itself
 * (`\`). Escaped with a backslash, which GFM renders as the literal character,
 * so the text still reads as the engine wrote it and none of it is structure.
 */
const MARKDOWN_META = /[\\`<>[\]()|*_~#!]/g;
/**
 * Block markers that only bite at the START of a line. Whitespace is already
 * collapsed to single spaces by the time these run, so a construct can only be
 * opened at the very front of the string, and only these two survive the inline
 * escaping above: a bullet (`-`/`+`) and an ordered item (`1.`). Both need the
 * trailing space that makes them a marker, which is also what keeps a version
 * stamp like `2026.06.0` out of it. They are neutralized here rather than
 * globally so ordinary prose keeps its hyphens and its full stops.
 */
const LEADING_BULLET = /^([-+])(?=\s|$)/;
const LEADING_ORDERED = /^(\d{1,9})\.(?=\s|$)/;
const ZERO_WIDTH = "\u200B";
const ELLIPSIS = "\u2026";

/**
 * Normalize control characters, collapse ALL whitespace (so no block-level
 * construct - heading, table, list, HTML block - can be injected via newlines),
 * cap the length, escape Markdown/HTML metacharacters, neutralize a leading
 * block marker, and defang `@mentions` and bare links. Returns safe single-line
 * inline text that can be dropped anywhere in a comment, including inside a
 * `<details>` block, a bold run, or a list item, without changing its shape.
 */
export function sanitizeDisplayText(text: string, maxLength = DEFAULT_MAX_LENGTH): string {
  let s = text.replace(CONTROL_CHARS, "").replace(/\s+/g, " ").trim();
  if (s.length > maxLength) s = `${s.slice(0, Math.max(0, maxLength - 1)).trimEnd()}${ELLIPSIS}`;
  return s
    .replace(MARKDOWN_META, (c) => `\\${c}`)
    .replace(LEADING_BULLET, "\\$1")
    .replace(LEADING_ORDERED, "$1\\.")
    .replace(/@/g, `@${ZERO_WIDTH}`) // neutralize @mentions
    .replace(/(https?):\/\//gi, `$1${ZERO_WIDTH}://`); // defang bare autolinks
}

const CODE_SPAN_MAX_LENGTH = 200;
/** Stand-in for a value that sanitizes down to nothing; an empty span is unclosed Markdown. */
const EMPTY_CODE_SPAN = "(empty)";

/**
 * Render an untrusted value INSIDE a code span, and return the span.
 *
 * A code span renders its contents literally, so nothing in it is Markdown or
 * HTML and backslash escaping does not apply there either: the only character
 * that matters is the backtick that would close the span early. So this is the
 * minimum that keeps the span closed - no control characters, no newlines, no
 * backticks, a length cap - and it deliberately does NOT escape or defang
 * anything else, because a value shown as code has to survive being read and
 * compared to what the operator configured.
 *
 * A caller placing the result in a GFM TABLE cell must still escape the pipe:
 * GFM requires that even inside a code span.
 */
export function sanitizeCodeSpan(value: string, maxLength = CODE_SPAN_MAX_LENGTH): string {
  // eslint-disable-next-line no-control-regex -- intentionally matches control chars to strip them
  const stripped = value.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
  const capped =
    stripped.length > maxLength
      ? `${stripped.slice(0, Math.max(0, maxLength - 1)).trimEnd()}${ELLIPSIS}`
      : stripped;
  const inert = capped.replace(/`/g, "'");
  return `\`${inert.length > 0 ? inert : EMPTY_CODE_SPAN}\``;
}

/** Longer than any real artifact URL; a longer one is not something Gate will link. */
const MAX_URL_LENGTH = 2048;

/**
 * Validate a URL that is about to become a Markdown link destination.
 *
 * Escaping is the wrong tool for a URL: escape it and the link stops working,
 * which is the whole point of publishing it. So this VALIDATES instead, and
 * returns `null` for anything it will not vouch for. A caller that gets `null`
 * must render inert text, never a link.
 *
 * The rules are the scheme and the shape:
 *   - it has to parse as an absolute URL, and
 *   - the scheme has to be `http` or `https`. `javascript:`, `data:` and
 *     `vbscript:` are the reason this function exists; a relative reference is
 *     rejected too, because Gate cannot tell what it would resolve against on a
 *     pull request page.
 *
 * What survives is re-serialized by the URL parser (which percent-encodes
 * whitespace and the delimiters that would end a destination early), checked
 * once more for anything that could break out of the parentheses, and finally
 * has its parentheses percent-encoded so a legitimate URL containing them
 * cannot close the destination.
 */
export function safeLinkUrl(raw: string): string | null {
  const candidate = raw.trim();
  if (candidate.length === 0 || candidate.length > MAX_URL_LENGTH) return null;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const serialized = parsed.toString();
  // Belt and braces: the parser should have encoded all of these already.
  if (/[\s<>"`\\]/.test(serialized)) return null;
  return serialized.replace(/\(/g, "%28").replace(/\)/g, "%29");
}

/**
 * Escape the pipes in a value bound for a GFM table cell. GFM ends a cell at an
 * unescaped `|` even inside a code span, so this is applied on top of
 * `sanitizeCodeSpan` (`sanitizeDisplayText` already escapes the pipe itself).
 */
export function escapeTableCell(text: string): string {
  return text.replace(/\|/g, "\\|");
}
