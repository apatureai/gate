import type { Finding, GateReviewResult, ReviewGrade, Severity } from "@gate/types";

/** Severity ladder, lowest to highest (mirrors the `.designreview.yml` enum). */
const SEVERITY_RANK: Record<Severity, number> = { nit: 0, minor: 1, major: 2, blocker: 3 };

/**
 * Keep only findings at or above `min` severity (`rules.min_severity_to_comment`,
 * TRD §7). This filters what the sticky comment *lists*; it never changes the
 * grade or Check Run conclusion (those reflect the engine's holistic verdict).
 * Defaults to `nit` — the lowest rung — so an unset threshold lists everything.
 */
export function findingsAtOrAbove(findings: Finding[], min: Severity = "nit"): Finding[] {
  const floor = SEVERITY_RANK[min];
  return findings.filter((f) => SEVERITY_RANK[f.severity] >= floor);
}

/**
 * Drop findings the repo has explicitly muted via `rules.suppress` (TRD §3). A
 * suppress entry matches a finding when it exactly equals the finding's stable
 * `id` or its `element` selector — the two identity fields callers can name in
 * `.designreview.yml` (`["f_001", "#cookie-banner"]`). Matching is exact, not
 * glob/regex: pattern semantics are undefined in the config contract, so an
 * ambiguous match is never guessed. Like the severity filter, this only changes
 * what the comment *lists*; the grade and Check Run conclusion still reflect the
 * engine's holistic verdict. An empty list (the default) keeps everything.
 */
export function suppressFindings(findings: Finding[], suppress: string[] = []): Finding[] {
  if (suppress.length === 0) return findings;
  const muted = new Set(suppress);
  return findings.filter((f) => !muted.has(f.id) && !(f.element !== null && muted.has(f.element)));
}

/**
 * Sticky PR comment (TRD §7.1): one comment per PR, found and updated by a
 * hidden HTML marker, with a blockers table and collapsed should-fix/nits — it
 * never spams new comments. The same component serves both paths; the GitHub
 * client (Action GITHUB_TOKEN or App installation token) is injected.
 */
export const STICKY_MARKER = "<!-- apature-gate:sticky -->";

const GRADE_LABEL: Record<ReviewGrade, string> = {
  ship: "✅ Ship",
  ship_with_nits: "✅ Ship with nits",
  needs_work: "⚠️ Needs work",
  blocked: "⛔ Blocked",
};

export interface StickyCommentContext {
  headSha: string;
  /** Gate-built public run URL (never the engine's URL). */
  runUrl?: string;
  /** Capture-instability caveat to surface (TRD §7; #38). */
  captureCaveat?: string;
  /**
   * Lowest severity that may be listed in the comment (`rules.min_severity_to_comment`).
   * Findings below it are omitted; unset lists everything (`nit`).
   */
  minSeverityToComment?: Severity;
  /**
   * Findings the repo muted via `rules.suppress`: entries matching a finding's
   * `id` or `element` are omitted from the comment. Unset/empty lists everything.
   */
  suppress?: string[];
}

const shortSha = (sha: string): string => sha.slice(0, 7);

function blockersTable(findings: Finding[]): string {
  const rows = findings
    .map((f) => `| ${f.title} | \`${f.route}\` | ${f.viewport} | ${f.suggestion ?? "—"} |`)
    .join("\n");
  return `### ⛔ Blockers\n\n| Finding | Route | Viewport | Suggestion |\n| --- | --- | --- | --- |\n${rows}`;
}

function findingList(findings: Finding[]): string {
  return findings
    .map((f) => `- **${f.title}** (\`${f.route}\`, ${f.viewport})${f.suggestion ? ` — ${f.suggestion}` : ""}`)
    .join("\n");
}

function detailsSection(title: string, findings: Finding[]): string | null {
  if (findings.length === 0) return null;
  return `<details>\n<summary>${title} (${findings.length})</summary>\n\n${findingList(findings)}\n\n</details>`;
}

/** Render the sticky comment markdown (pure). */
export function renderStickyComment(result: GateReviewResult, ctx: StickyCommentContext): string {
  const findings = findingsAtOrAbove(
    suppressFindings(result.findings, ctx.suppress),
    ctx.minSeverityToComment,
  );
  const blockers = findings.filter((f) => f.severity === "blocker");
  const shouldFix = findings.filter((f) => f.severity === "major" || f.severity === "minor");
  const nits = findings.filter((f) => f.severity === "nit");

  const parts: string[] = [
    STICKY_MARKER,
    "## Apature Gate — design review",
    `**${GRADE_LABEL[result.grade]}** · reviewed \`${shortSha(ctx.headSha)}\``,
    result.overall,
  ];

  if (blockers.length > 0) parts.push(blockersTable(blockers));
  const sf = detailsSection("Should fix", shouldFix);
  if (sf) parts.push(sf);
  const nt = detailsSection("Nits", nits);
  if (nt) parts.push(nt);

  // Always render "not reviewed" when anything was skipped — never silently drop.
  if (result.notReviewed.length > 0) {
    parts.push(`### Not reviewed\n\n${result.notReviewed.map((n) => `- ${n}`).join("\n")}`);
  }

  if (ctx.captureCaveat) parts.push(`> ⚠️ ${ctx.captureCaveat}`);

  // Page-health footnote: lineage stamp so every finding is traceable.
  const foot = [
    `engine ${result.metadata.engineVersion}`,
    `model ${result.metadata.model}`,
    `capture ${result.metadata.captureVersion}`,
  ];
  if (result.metadata.uiDnaVersion) foot.push(`ui-dna ${result.metadata.uiDnaVersion}`);
  if (ctx.runUrl) foot.push(`[run details](${ctx.runUrl})`);
  parts.push(`<sub>${foot.join(" · ")}</sub>`);

  return parts.join("\n\n");
}

export interface IssueComment {
  id: number;
  /** GraphQL node id; used for the optimistic concurrent-edit check. */
  nodeId: string;
  body: string;
}

export interface GitHubCommentsApi {
  listComments(): Promise<IssueComment[]>;
  createComment(body: string): Promise<IssueComment>;
  /** Update only if the comment's node id still matches (optimistic guard). */
  updateComment(id: number, body: string, expectedNodeId: string): Promise<{ updated: boolean }>;
}

export type UpsertOutcome =
  | { action: "created"; commentId: number }
  | { action: "updated"; commentId: number }
  | { action: "skipped_stale"; commentId: number };

/**
 * Find-and-update the single sticky comment by its hidden marker, or create it.
 * The optimistic node_id check closes the concurrent-edit race: if a newer
 * writer already updated the comment, this update is rejected rather than
 * clobbering the newer content.
 */
export async function upsertStickyComment(
  api: GitHubCommentsApi,
  body: string,
): Promise<UpsertOutcome> {
  const comments = await api.listComments();
  const existing = comments.find((c) => c.body.includes(STICKY_MARKER));
  if (!existing) {
    const created = await api.createComment(body);
    return { action: "created", commentId: created.id };
  }
  const res = await api.updateComment(existing.id, body, existing.nodeId);
  return res.updated
    ? { action: "updated", commentId: existing.id }
    : { action: "skipped_stale", commentId: existing.id };
}
