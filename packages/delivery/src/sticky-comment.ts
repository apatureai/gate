import type { Finding, GateReviewResult, ReviewGrade } from "@gate/types";

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
  const blockers = result.findings.filter((f) => f.severity === "blocker");
  const shouldFix = result.findings.filter((f) => f.severity === "major" || f.severity === "minor");
  const nits = result.findings.filter((f) => f.severity === "nit");

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
