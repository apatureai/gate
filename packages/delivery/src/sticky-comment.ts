import type { Finding, GateReviewResult, ReviewGrade, Severity } from "@gate/types";
import {
  footerModel,
  judgmentBanner,
  judgmentState,
  suppressesGrade,
} from "./judgment.js";
import { sanitizeDisplayText } from "./sanitize.js";

/** Severity ladder, lowest to highest (mirrors the `.gate.yml` enum). */
const SEVERITY_RANK: Record<Severity, number> = { nit: 0, minor: 1, major: 2, blocker: 3 };

/**
 * Keep only findings at or above `min` severity (`rules.min_severity_to_comment`,
 * TRD §7). This filters what the sticky comment *lists*; it never changes the
 * grade or Check Run conclusion (those reflect the engine's holistic verdict).
 * Defaults to `nit`, the lowest rung, so an unset threshold lists everything.
 */
export function findingsAtOrAbove(findings: Finding[], min: Severity = "nit"): Finding[] {
  const floor = SEVERITY_RANK[min];
  return findings.filter((f) => SEVERITY_RANK[f.severity] >= floor);
}

/**
 * Drop findings the repo has explicitly muted via `rules.suppress` (TRD §3). A
 * suppress entry matches a finding when it exactly equals the finding's stable
 * `id` or its `element` selector, the two identity fields callers can name in
 * `.gate.yml` (`["f_001", "#cookie-banner"]`). Matching is exact, not
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
 * hidden HTML marker, with a blockers table and collapsed should-fix/nits, so it
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

function screenshotLinks(result: GateReviewResult): Map<string, string> {
  return new Map(result.artifacts.annotatedScreenshots.map((shot) => [shot.findingId, shot.url]));
}

function evidenceLink(finding: Finding, screenshots: Map<string, string>): string {
  const url = screenshots.get(finding.id);
  return url ? `[Evidence](${url})` : "none";
}

function findingSummary(finding: Finding, screenshots: Map<string, string>): string {
  const evidence = screenshots.get(finding.id);
  return (
    `**${finding.title}** (\`${finding.route}\`, ${finding.viewport})` +
    `${finding.suggestion ? `. ${finding.suggestion}` : ""}` +
    `${evidence ? ` · [Evidence](${evidence})` : ""}`
  );
}

function blockersTable(findings: Finding[], screenshots: Map<string, string>): string {
  const rows = findings
    .map((f) => `| ${f.title} | \`${f.route}\` | ${f.viewport} | ${f.suggestion ?? "none"} | ${evidenceLink(f, screenshots)} |`)
    .join("\n");
  return `### ⛔ Blockers\n\n| Finding | Route | Viewport | Suggestion | Evidence |\n| --- | --- | --- | --- | --- |\n${rows}`;
}

function findingList(findings: Finding[], screenshots: Map<string, string>): string {
  return findings
    .map((f) => `- ${findingSummary(f, screenshots)}`)
    .join("\n");
}

function detailsSection(title: string, findings: Finding[], screenshots: Map<string, string>): string | null {
  if (findings.length === 0) return null;
  return `<details>\n<summary>${title} (${findings.length})</summary>\n\n${findingList(findings, screenshots)}\n\n</details>`;
}

/**
 * Render the sticky comment markdown (pure).
 *
 * When the engine does not state that a model judged the page, the grade, the
 * narrative and the findings are all withheld and the comment leads with the
 * disclosure instead. The heading also drops "design review", because Gate
 * cannot say a design review happened. What survives is what is actually true of
 * such a run: the page was captured and measured.
 */
export function renderStickyComment(result: GateReviewResult, ctx: StickyCommentContext): string {
  const screenshots = screenshotLinks(result);
  const state = judgmentState(result);
  const graded = !suppressesGrade(state);
  const findings = findingsAtOrAbove(
    suppressFindings(result.findings, ctx.suppress),
    ctx.minSeverityToComment,
  );
  const blockers = findings.filter((f) => f.severity === "blocker");
  const shouldFix = findings.filter((f) => f.severity === "major" || f.severity === "minor");
  const nits = findings.filter((f) => f.severity === "nit");

  const parts: string[] = [STICKY_MARKER];
  if (graded) {
    parts.push(
      "## Apature Gate: design review",
      `**${GRADE_LABEL[result.grade]}** · reviewed \`${shortSha(ctx.headSha)}\``,
      result.overall,
    );
  } else {
    parts.push(
      "## Apature Gate: no design review",
      `${judgmentBanner(state)} · captured \`${shortSha(ctx.headSha)}\``,
      state === "unattested"
        ? "The page was captured and measured for real. The engine did not state whether a model " +
            "judged it, so Gate is withholding the grade, the summary and any findings this run " +
            "carried rather than showing them as a verdict on your UI. An engine that did call a " +
            "model says so on the result, with `provenance.model_backed: true`."
        : "The page was captured and measured for real. Nothing critiqued it, so Gate is withholding " +
            "the grade, the summary and any findings this run carried rather than showing them as a " +
            "verdict on your UI. Point Gate at an engine with a model configured to get a review.",
    );
    if (result.findings.length > 0) {
      parts.push(
        state === "unattested"
          ? `_${result.findings.length} finding(s) were returned and are not listed; the engine ` +
              "did not state what produced them._"
          : `_${result.findings.length} unjudged finding(s) were returned and are not listed; ` +
              "nothing produced them but a stand-in._",
      );
    }
  }

  if (graded) {
    if (blockers.length > 0) parts.push(blockersTable(blockers, screenshots));
    const sf = detailsSection("Should fix", shouldFix, screenshots);
    if (sf) parts.push(sf);
    const nt = detailsSection("Nits", nits, screenshots);
    if (nt) parts.push(nt);
  }

  // Always render "not reviewed" when anything was skipped; never silently drop.
  if (result.notReviewed.length > 0) {
    parts.push(`### Not reviewed\n\n${result.notReviewed.map((n) => `- ${n}`).join("\n")}`);
  }

  if (ctx.captureCaveat) parts.push(`> ⚠️ ${ctx.captureCaveat}`);

  // Capture-health caveat: the engine's page-health footnote (Verdict #20), rendered
  // as informational untrusted display text. It never changes grade, severity,
  // or the Check Run conclusion; those stay the engine's holistic verdict.
  const health = result.artifacts.pageHealthFootnote;
  if (health !== undefined && health.trim().length > 0) {
    parts.push(`> 🩺 **Capture health:** ${sanitizeDisplayText(health)}`);
  }

  // Version-lineage footer: engine/model/capture/dna stamps so every finding is traceable.
  const foot = [
    `engine ${result.metadata.engineVersion}`,
    `model ${footerModel(result)}`,
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
