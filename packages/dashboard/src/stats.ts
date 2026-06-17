import type { FeedbackEventType } from "@gate/types";
import type { SqlQuery } from "./runs.js";

/**
 * Feedback stats (TRD §13, §8): per-repo acceptance/rejection rates by dimension,
 * trended over time, sourced from the feedback store. Pure aggregation + a SQL
 * loader; the dashboard renders the result.
 */
export type Sentiment = "positive" | "negative" | "neutral";

export interface FeedbackLike {
  type: FeedbackEventType;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
}

/** Classify a feedback event as acceptance/rejection/neutral. */
export function classifyFeedback(event: FeedbackLike): Sentiment {
  switch (event.type) {
    case "suggestion_adopted":
      return "positive";
    case "ignore_suppress":
    case "merged_with_unresolved_blockers":
      return "negative";
    case "reaction":
    case "slash_command": {
      const vote = event.metadata?.["vote"];
      if (vote === "up" || vote === "positive") return "positive";
      if (vote === "down" || vote === "negative") return "negative";
      return "neutral";
    }
    default:
      return "neutral";
  }
}

export interface RateCounts {
  positive: number;
  negative: number;
  neutral: number;
  total: number;
  /** positive / (positive + negative); 0 when no decisive feedback. */
  acceptanceRate: number;
}

function tally(events: FeedbackLike[]): RateCounts {
  let positive = 0;
  let negative = 0;
  let neutral = 0;
  for (const e of events) {
    const s = classifyFeedback(e);
    if (s === "positive") positive += 1;
    else if (s === "negative") negative += 1;
    else neutral += 1;
  }
  const decisive = positive + negative;
  return {
    positive,
    negative,
    neutral,
    total: events.length,
    acceptanceRate: decisive === 0 ? 0 : positive / decisive,
  };
}

export function computeFeedbackStats(events: FeedbackLike[]): RateCounts {
  return tally(events);
}

/** Acceptance/rejection by a dimension (e.g. severity) drawn from metadata. */
export function statsByDimension(
  events: FeedbackLike[],
  getDimension: (event: FeedbackLike) => string | null,
): Record<string, RateCounts> {
  const groups = new Map<string, FeedbackLike[]>();
  for (const e of events) {
    const dim = getDimension(e);
    if (dim === null) continue;
    const list = groups.get(dim) ?? [];
    list.push(e);
    groups.set(dim, list);
  }
  const out: Record<string, RateCounts> = {};
  for (const [dim, list] of groups) out[dim] = tally(list);
  return out;
}

export interface TrendPoint extends RateCounts {
  bucket: string;
}

/** UTC day bucket key for a timestamp. */
export function dayBucket(createdAt: string): string {
  return new Date(createdAt).toISOString().slice(0, 10);
}

/** Acceptance trend over time, ascending by bucket. */
export function feedbackTrend(
  events: FeedbackLike[],
  bucketOf: (createdAt: string) => string = dayBucket,
): TrendPoint[] {
  const groups = new Map<string, FeedbackLike[]>();
  for (const e of events) {
    const bucket = bucketOf(e.createdAt);
    const list = groups.get(bucket) ?? [];
    list.push(e);
    groups.set(bucket, list);
  }
  return [...groups.keys()]
    .sort()
    .map((bucket) => ({ bucket, ...tally(groups.get(bucket)!) }));
}

interface FeedbackRow {
  type: FeedbackEventType;
  metadata: Record<string, unknown> | string | null;
  created_at: string | Date;
}

/** Load a repo's feedback events (tenant-scoped query, so RLS applies). */
export async function loadFeedbackEvents(
  query: SqlQuery,
  params: { owner: string; name: string; since?: string },
): Promise<FeedbackLike[]> {
  const where = ["repo_owner = $1", "repo_name = $2"];
  const args: unknown[] = [params.owner, params.name];
  if (params.since) {
    args.push(params.since);
    where.push(`created_at >= $${args.length}`);
  }
  const { rows } = await query<FeedbackRow>(
    `SELECT type, metadata, created_at FROM feedback_events WHERE ${where.join(" AND ")} ORDER BY created_at`,
    args,
  );
  return rows.map((r) => ({
    type: r.type,
    metadata: typeof r.metadata === "string" ? (JSON.parse(r.metadata) as Record<string, unknown>) : r.metadata,
    createdAt: new Date(r.created_at).toISOString(),
  }));
}
