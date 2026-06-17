import { randomUUID } from "node:crypto";
import type { FeedbackEvent, FeedbackEventType } from "@gate/types";
import type { FeedbackSink } from "./feedback-routes.js";
import type { SqlQuery } from "./review-window.js";

/**
 * Feedback event model + forwarding (TRD §9; PRD §10). Gate records the
 * product-facing signal (incl. the rater's repo-permission level and source) and
 * forwards it to the shared feedback store owned by judgment-engine, which owns
 * weighting and the preference dataset. Non-collaborator down-weighting is the
 * engine's job. Implicit positive is detected by suggestion string-match ONLY —
 * "touched the element" never counts.
 */

export interface FeedbackEventContext {
  installationId: string;
  owner: string;
  name: string;
  prNumber: number;
  headSha: string;
  findingId?: string | null;
  actor?: { login: string; isCollaborator: boolean; permission?: string } | null;
  /** How the signal arrived: reaction | slash_command | merge | diff_match | system. */
  source: string;
  metadata?: Record<string, unknown>;
}

/** Build a typed FeedbackEvent, stamping source + permission into metadata. */
export function buildFeedbackEvent(
  type: FeedbackEventType,
  ctx: FeedbackEventContext,
  createdAtMs: number = Date.now(),
): FeedbackEvent {
  return {
    id: randomUUID(),
    type,
    installationId: ctx.installationId,
    repository: { owner: ctx.owner, name: ctx.name },
    pullRequest: { number: ctx.prNumber, headSha: ctx.headSha },
    findingId: ctx.findingId ?? null,
    actor: ctx.actor ?? null,
    createdAt: new Date(createdAtMs).toISOString(),
    metadata: { source: ctx.source, ...ctx.metadata },
  };
}

/**
 * Extract suggestion code tokens (backticked spans, else the trimmed text) so
 * adoption is matched on the suggested token/class STRING, never on whether the
 * element was merely touched.
 */
export function extractSuggestionTokens(suggestion: string): string[] {
  const backticked = [...suggestion.matchAll(/`([^`]+)`/g)].map((m) => m[1]!.trim()).filter(Boolean);
  if (backticked.length > 0) return backticked;
  const trimmed = suggestion.trim();
  return trimmed ? [trimmed] : [];
}

/** True only if a suggested token/class string appears in the later diff. */
export function detectSuggestionAdoption(suggestion: string, diffText: string): boolean {
  return extractSuggestionTokens(suggestion).some((token) => diffText.includes(token));
}

export interface FeedbackStore {
  persist(event: FeedbackEvent): Promise<void>;
}

export function createInMemoryFeedbackStore(): FeedbackStore & { events: FeedbackEvent[] } {
  const events: FeedbackEvent[] = [];
  return {
    events,
    async persist(event) {
      events.push(event);
    },
  };
}

/** Postgres-backed store; runs under a tenant-scoped QueryFn so RLS applies. */
export function createSqlFeedbackStore(query: SqlQuery): FeedbackStore {
  return {
    async persist(event) {
      await query(
        `INSERT INTO feedback_events
           (installation_id, type, repo_owner, repo_name, pr_number, head_sha,
            finding_id, actor_login, actor_is_collaborator, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          Number(event.installationId),
          event.type,
          event.repository.owner,
          event.repository.name,
          event.pullRequest.number,
          event.pullRequest.headSha,
          event.findingId,
          event.actor?.login ?? null,
          event.actor?.isCollaborator ?? null,
          JSON.stringify({ ...event.metadata, permission: event.actor?.permission ?? null }),
        ],
      );
    },
  };
}

/** Forwards events to the shared store (engine). Best-effort at the sink. */
export interface SharedFeedbackForwarder {
  forward(event: FeedbackEvent): Promise<void>;
}

export function createHttpFeedbackForwarder(
  endpoint: string,
  fetchImpl: typeof fetch = fetch,
): SharedFeedbackForwarder {
  return {
    async forward(event) {
      const res = await fetchImpl(`${endpoint.replace(/\/$/, "")}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(event),
      });
      if (!res.ok) throw new Error(`feedback forward failed: ${res.status}`);
    },
  };
}

/**
 * Compose persistence + forwarding into the FeedbackSink the routes (#13) and
 * orchestrator use. Persistence is authoritative; forwarding is best-effort so a
 * shared-store hiccup never drops the local record.
 */
export function createFeedbackSink(
  store: FeedbackStore,
  forwarder?: SharedFeedbackForwarder,
): FeedbackSink {
  return {
    async record(event) {
      await store.persist(event);
      if (forwarder) {
        try {
          await forwarder.forward(event);
        } catch {
          // best-effort; the local record is the source of truth.
        }
      }
    },
  };
}
