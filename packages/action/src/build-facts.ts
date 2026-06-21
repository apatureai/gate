import type { PreviewBuildFact, PreviewBuildFactKind } from "@gate/types";

/**
 * Parse build/runtime diagnostics out of a preview-command's output (#70 U1).
 * The local-serve supervisor already captures the dev server's stdout/stderr;
 * this turns it into structured facts the engine can ground its critique on
 * (a hydration warning, a failed compile, a 404'd asset are design-quality
 * signals a screenshot alone hides). Framework-agnostic, line-based, conservative
 * (only well-known patterns), deduped, and capped so it can never bloat the
 * request. Pure — no I/O.
 */
const MAX_FACTS = 20;
const MAX_MESSAGE_LEN = 300;

interface Pattern {
  kind: PreviewBuildFactKind;
  test: RegExp;
}

// Ordered by specificity; the first matching pattern classifies a line.
const PATTERNS: Pattern[] = [
  { kind: "compile_error", test: /\b(failed to compile|compilation failed|build failed|SyntaxError|Module not found|Cannot find module|Type error:)\b/i },
  { kind: "hydration", test: /\bhydrat(e|ion)\b.*(mismatch|error|fail|did not match)/i },
  { kind: "asset_error", test: /\b(404|failed to load|ChunkLoadError|Loading chunk \d+ failed|ENOENT).*\b(asset|chunk|font|image|\.css|\.js|\.woff)\b/i },
  { kind: "deprecation", test: /\b(deprecat(ed|ion)|DeprecationWarning)\b/i },
  { kind: "warning", test: /\b(warning|warn)\b/i },
];

function classify(line: string): PreviewBuildFactKind | null {
  for (const p of PATTERNS) {
    if (p.test.test(line)) return p.kind;
  }
  return null;
}

/** Strip ANSI color codes dev servers emit, so patterns match clean text. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\[[0-9;]*m/g, "");
}

export function parsePreviewBuildFacts(output: string): PreviewBuildFact[] {
  const facts: PreviewBuildFact[] = [];
  const seen = new Set<string>();
  for (const raw of output.split(/\r?\n/)) {
    const line = stripAnsi(raw).trim();
    if (!line) continue;
    const kind = classify(line);
    if (!kind) continue;
    const message = line.length > MAX_MESSAGE_LEN ? `${line.slice(0, MAX_MESSAGE_LEN)}…` : line;
    const key = `${kind}:${message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    facts.push({ kind, message });
    if (facts.length >= MAX_FACTS) break;
  }
  return facts;
}
