/**
 * Product-facing feedback events (TRD §9).
 *
 * Gate records these and forwards them to the shared feedback store. Quality
 * rules (GET is inert, non-collaborator feedback is down-weighted, "touched the
 * element" is not implicit positive) are enforced at capture and in the shared
 * data layer, not encoded in this type.
 */
export type FeedbackEventType =
  | "finding_posted"
  | "finding_expanded"
  | "reaction"
  | "slash_command"
  | "ignore_suppress"
  | "merged_with_unresolved_blockers"
  | "suggestion_adopted";

export type FeedbackActor = {
  login: string;
  /** Whether the actor is a repo collaborator; drives down-weighting. */
  isCollaborator: boolean;
};

export type FeedbackEvent = {
  id: string;
  type: FeedbackEventType;
  installationId: string;
  repository: {
    owner: string;
    name: string;
  };
  pullRequest: {
    number: number;
    headSha: string;
  };
  /** Finding this event refers to, or null for PR-level events. */
  findingId: string | null;
  /** Actor who produced the event, or null for system-generated events. */
  actor: FeedbackActor | null;
  /** ISO 8601 timestamp. */
  createdAt: string;
  metadata?: Record<string, unknown>;
};
