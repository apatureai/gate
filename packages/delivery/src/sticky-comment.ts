import type {
  Finding,
  GateReviewResult,
  MeasurementsMode,
  ReviewGrade,
  Severity,
} from "@gate/types";
import { coverageState, notReviewedItems, suppressesGradeForCoverage } from "./coverage.js";
import {
  footerModel,
  judgmentBanner,
  judgmentState,
  suppressesGrade,
} from "./judgment.js";
import { measurementBlock } from "./measurements.js";
import {
  escapeTableCell,
  safeLinkUrl,
  sanitizeCodeSpan,
  sanitizeDisplayText,
} from "./sanitize.js";

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
  /**
   * `rules.measurements`. Defaults to `advisory`. The measured block is rendered
   * on every path, including the withheld-grade ones, because a measurement is
   * true whether or not a model ran. It never changes what this comment says
   * about the grade.
   */
  measurements?: MeasurementsMode;
  /** `rules.measurement_suppress`: exact `element` or `"<kind>:<element>"` matches. */
  measurementSuppress?: readonly string[];
}

const shortSha = (sha: string): string => sha.slice(0, 7);

/**
 * Display bounds for the untrusted fields, in characters.
 *
 * EVERY string below originates with the engine or the model, and the model's
 * prose derives partly from the page text of the pull request under review, so a
 * pull request author has influence over it without controlling the engine. They
 * are therefore rendered through `sanitize.ts` (never interpolated raw), which
 * both escapes the Markdown structure out of them and caps them here so one
 * finding cannot flood the comment.
 */
const OVERALL_MAX = 2_000;
const TITLE_MAX = 300;
const SUGGESTION_MAX = 1_000;
const ROUTE_MAX = 120;
const VIEWPORT_MAX = 40;
/** Version stamps in the lineage footer: short by construction, engine-supplied all the same. */
const STAMP_MAX = 80;

function screenshotLinks(result: GateReviewResult): Map<string, string> {
  return new Map(result.artifacts.annotatedScreenshots.map((shot) => [shot.findingId, shot.url]));
}

/**
 * The engine's evidence URL for a finding, but only when Gate will vouch for it.
 *
 * The URL is a link DESTINATION, so escaping it would break the link rather than
 * make it safe; it is validated instead (`safeLinkUrl`). A destination that is
 * not absolute http(s) never becomes a link at all: the reader is told the
 * evidence exists and that Gate would not link it, which is the honest outcome
 * and cannot be mistaken for a Gate-endorsed destination.
 */
const EVIDENCE_NOT_LINKABLE = "evidence not linkable";

function evidenceHref(finding: Finding, screenshots: Map<string, string>): string | null {
  const url = screenshots.get(finding.id);
  return url === undefined ? null : safeLinkUrl(url);
}

function evidenceCell(finding: Finding, screenshots: Map<string, string>): string {
  if (!screenshots.has(finding.id)) return "none";
  const href = evidenceHref(finding, screenshots);
  // WHATWG URL does not percent-encode `|` in a path, and GFM ends a cell at an
  // unescaped pipe, so an evidence URL containing one used to break the row and
  // lose the link entirely. Escaping it keeps the link intact and the row square.
  return href ? `[Evidence](${escapeTableCell(href)})` : EVIDENCE_NOT_LINKABLE;
}

function findingSummary(finding: Finding, screenshots: Map<string, string>): string {
  const href = evidenceHref(finding, screenshots);
  const evidence = href
    ? ` · [Evidence](${href})`
    : screenshots.has(finding.id)
      ? ` · ${EVIDENCE_NOT_LINKABLE}`
      : "";
  return (
    `**${sanitizeDisplayText(finding.title, TITLE_MAX)}** ` +
    `(${sanitizeCodeSpan(finding.route, ROUTE_MAX)}, ${sanitizeDisplayText(finding.viewport, VIEWPORT_MAX)})` +
    `${finding.suggestion ? `. ${sanitizeDisplayText(finding.suggestion, SUGGESTION_MAX)}` : ""}` +
    evidence
  );
}

function blockersTable(findings: Finding[], screenshots: Map<string, string>): string {
  const rows = findings
    .map((f) =>
      // `escapeTableCell` only on the route: GFM ends a cell at an unescaped pipe
      // even inside a code span, and `sanitizeDisplayText` escapes the pipe itself.
      `| ${sanitizeDisplayText(f.title, TITLE_MAX)} ` +
      `| ${escapeTableCell(sanitizeCodeSpan(f.route, ROUTE_MAX))} ` +
      `| ${sanitizeDisplayText(f.viewport, VIEWPORT_MAX)} ` +
      `| ${f.suggestion ? sanitizeDisplayText(f.suggestion, SUGGESTION_MAX) : "none"} ` +
      `| ${evidenceCell(f, screenshots)} |`,
    )
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
 *
 * The same withholding applies when the engine states it reviewed NOTHING
 * (verdict#165), and for the same reason. It is applied here as well as in
 * `buildCheckRun` so the two surfaces published side by side on one PR always
 * say the same thing about the same run.
 *
 * EVERY engine- or model-supplied string on this comment goes through
 * `sanitize.ts` on its way in. This comment is Markdown, and its structure is
 * what tells a reader which words are Gate's: a finding whose text can close the
 * `<details>` block it sits in and open a second `## Apature Gate: design review`
 * heading with a bold `✅ Ship` under it has forged a Gate verdict on the pull
 * request, and the model's prose derives partly from the page text of the pull
 * request under review, so its author has influence over that text. Nothing is
 * interpolated raw here: prose is escaped, values shown as code are rendered
 * through a closed code span, and link destinations are validated rather than
 * escaped.
 */
export function renderStickyComment(result: GateReviewResult, ctx: StickyCommentContext): string {
  const screenshots = screenshotLinks(result);
  const state = judgmentState(result);
  const nothingReviewed = suppressesGradeForCoverage(coverageState(result));
  const graded = !suppressesGrade(state) && !nothingReviewed;
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
      sanitizeDisplayText(result.overall, OVERALL_MAX),
    );
  } else if (nothingReviewed) {
    parts.push(
      "## Apature Gate: no design review",
      `⚠️ **Nothing reviewed**: the engine judged none of the requested routes, so there is no grade. ` +
        `· captured \`${shortSha(ctx.headSha)}\``,
      "A result with no findings grades `ship` by construction, so the grade this run carried " +
        "says nothing about your UI and Gate is withholding it along with the summary. What was " +
        "skipped, and why, is listed below.",
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
  // Same sanitized, bounded items the Check Run renders, so the two surfaces
  // cannot disagree about what was skipped OR about how it was neutralized.
  const skipped = notReviewedItems(result);
  if (skipped) parts.push(`### Not reviewed\n\n${skipped}`);

  // The measured half, rendered on every path for the same reason the Check Run
  // renders it on every path: it is computed from the captured DOM with no model
  // involved, so it is the one part of an unjudged run that is not withheld.
  // The comment's own prose says "the page was captured and measured"; this is
  // what that sentence points at.
  const measured = measurementBlock(result, {
    mode: ctx.measurements ?? "advisory",
    suppress: ctx.measurementSuppress ?? [],
  });
  if (measured) parts.push(measured);

  // Gate-owned prose, built from Gate's own signals; not engine text.
  if (ctx.captureCaveat) parts.push(`> ⚠️ ${ctx.captureCaveat}`);

  // Capture-health caveat: the engine's page-health footnote (Verdict #20), rendered
  // as informational untrusted display text. It never changes grade, severity,
  // or the Check Run conclusion; those stay the engine's holistic verdict.
  const health = result.artifacts.pageHealthFootnote;
  if (health !== undefined && health.trim().length > 0) {
    parts.push(`> 🩺 **Capture health:** ${sanitizeDisplayText(health)}`);
  }

  // Version-lineage footer: engine/model/capture/dna stamps so every finding is
  // traceable. These are engine-supplied strings like any other, and they are
  // rendered inside an HTML element, so an unsanitized stamp could close the
  // `<sub>` and forge a verdict below it exactly as a finding could.
  const foot = [
    `engine ${sanitizeDisplayText(result.metadata.engineVersion, STAMP_MAX)}`,
    `model ${footerModel(result)}`,
    `capture ${sanitizeDisplayText(result.metadata.captureVersion, STAMP_MAX)}`,
  ];
  if (result.metadata.uiDnaVersion) {
    foot.push(`ui-dna ${sanitizeDisplayText(result.metadata.uiDnaVersion, STAMP_MAX)}`);
  }
  // Gate-built, never the engine's URL, and validated anyway: this one is a link.
  const runUrl = ctx.runUrl ? safeLinkUrl(ctx.runUrl) : null;
  if (runUrl) foot.push(`[run details](${runUrl})`);
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
