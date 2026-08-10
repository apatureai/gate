import { randomUUID } from "node:crypto";
import type { FeedbackEvent } from "@gate/types";
import type { FastifyInstance } from "fastify";
import {
  type ConsumedTokenStore,
  createInMemoryConsumedStore,
  type FeedbackVotePayload,
  verifyFeedbackToken,
} from "./feedback-token.js";

/**
 * POST-only feedback endpoints (TRD §7.1, §8). The canonical signal is the
 * GitHub reaction API or the `/design-review` slash command; any link points at
 * a confirm page whose vote is a POST behind a one-time HMAC token. GET is inert.
 */
export interface FeedbackSink {
  record(event: FeedbackEvent): Promise<void>;
}

export interface FeedbackRouteOptions {
  secret: string;
  sink: FeedbackSink;
  consumed?: ConsumedTokenStore;
  now?: () => number;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function toFeedbackEvent(payload: FeedbackVotePayload, createdAtMs: number): FeedbackEvent {
  return {
    id: randomUUID(),
    type: payload.type,
    installationId: payload.installationId,
    repository: { owner: payload.owner, name: payload.name },
    pullRequest: { number: payload.prNumber, headSha: payload.headSha },
    findingId: payload.findingId,
    actor: null,
    createdAt: new Date(createdAtMs).toISOString(),
  };
}

export function registerFeedbackRoutes(app: FastifyInstance, options: FeedbackRouteOptions): void {
  const consumed = options.consumed ?? createInMemoryConsumedStore();
  const now = options.now ?? Date.now;

  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => {
    const params = new URLSearchParams(typeof body === "string" ? body : body.toString("utf8"));
    done(null, Object.fromEntries(params));
  });

  // Inert confirm page (GET): renders a POST form, mutates nothing.
  app.get("/feedback/confirm", async (request, reply) => {
    const token = (request.query as { token?: string }).token ?? "";
    return reply
      .header("content-type", "text/html; charset=utf-8")
      .send(
        `<!doctype html><meta name="robots" content="noindex"><form method="POST" action="/feedback">` +
          `<input type="hidden" name="token" value="${escapeHtml(token)}">` +
          `<button type="submit">Confirm feedback</button></form>`,
      );
  });

  // GET must never mutate, so a prefetch/scan hitting /feedback is rejected.
  app.get("/feedback", async (_request, reply) => reply.code(405).send({ error: "use POST" }));

  app.post("/feedback", async (request, reply) => {
    const token = (request.body as { token?: string } | undefined)?.token ?? "";
    const verified = verifyFeedbackToken(token, options.secret, now());
    if (!verified.ok) return reply.code(400).send({ error: verified.reason });
    if (!(await consumed.consume(verified.payload.jti))) {
      return reply.code(409).send({ error: "already_used" });
    }
    await options.sink.record(toFeedbackEvent(verified.payload, now()));
    return reply.code(200).send({ recorded: true });
  });
}

export interface SlashCommand {
  command: string;
  args: string[];
}

/** Parse a `/design-review <command> [args...]` slash command from a comment. */
export function parseDesignReviewCommand(commentBody: string): SlashCommand | null {
  const match = commentBody.trim().match(/^\/design-review\s+(\S+)(?:\s+(.*))?$/);
  if (!match) return null;
  return { command: match[1]!, args: match[2] ? match[2].trim().split(/\s+/) : [] };
}
