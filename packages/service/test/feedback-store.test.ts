import { PGlite } from "@electric-sql/pglite";
import { pgliteExecutor, runMigrations } from "@gate/db";
import type { FeedbackEventType } from "@gate/types";
import { describe, expect, it, vi } from "vitest";
import {
  buildFeedbackEvent,
  createFeedbackSink,
  createInMemoryFeedbackStore,
  createSqlFeedbackStore,
  detectSuggestionAdoption,
  extractSuggestionTokens,
  type FeedbackEventContext,
} from "../src/feedback-store.js";

const ctx: FeedbackEventContext = {
  installationId: "1",
  owner: "acme",
  name: "web",
  prNumber: 42,
  headSha: "abc",
  findingId: "f_001",
  actor: { login: "dev", isCollaborator: true, permission: "write" },
  source: "reaction",
};

describe("buildFeedbackEvent", () => {
  it("stamps source + actor and supports every event type", () => {
    const types: FeedbackEventType[] = [
      "finding_posted",
      "reaction",
      "slash_command",
      "ignore_suppress",
      "merged_with_unresolved_blockers",
      "suggestion_adopted",
    ];
    for (const type of types) {
      const e = buildFeedbackEvent(type, ctx, 1000);
      expect(e.type).toBe(type);
      expect(e.metadata?.source).toBe("reaction");
      expect(e.actor?.permission).toBe("write");
    }
  });
});

describe("detectSuggestionAdoption (string-match only)", () => {
  it("matches a backticked token that appears in the later diff", () => {
    expect(detectSuggestionAdoption("Use the `--color-accent` token", "+ color: var(--color-accent);")).toBe(true);
    expect(extractSuggestionTokens("Use `btn-primary` and `--color-accent`")).toEqual(["btn-primary", "--color-accent"]);
  });

  it("does NOT count merely touching the element (no token match)", () => {
    expect(detectSuggestionAdoption("Use the `--color-accent` token", "+ <button class='cta'>Buy</button>")).toBe(false);
  });
});

describe("createFeedbackSink", () => {
  it("persists then best-effort forwards (forward failure doesn't drop the record)", async () => {
    const store = createInMemoryFeedbackStore();
    const forward = vi.fn(async () => {
      throw new Error("shared store down");
    });
    const sink = createFeedbackSink(store, { forward });
    await sink.record(buildFeedbackEvent("reaction", ctx, 1000));
    expect(store.events).toHaveLength(1); // persisted despite forward failure
    expect(forward).toHaveBeenCalledOnce();
  });

  it("forwards when the shared store is healthy", async () => {
    const store = createInMemoryFeedbackStore();
    const forward = vi.fn(async () => {});
    await createFeedbackSink(store, { forward }).record(buildFeedbackEvent("slash_command", ctx, 1000));
    expect(forward).toHaveBeenCalledOnce();
  });
});

describe("createSqlFeedbackStore", () => {
  it("inserts into feedback_events on the real schema", async () => {
    const db = new PGlite();
    await runMigrations(pgliteExecutor(db));
    await db.exec("INSERT INTO installations (id, account_login, account_id) VALUES (1, 'acme', 10)");

    const store = createSqlFeedbackStore((sql, params) => db.query(sql, params as unknown[]));
    await store.persist(buildFeedbackEvent("reaction", ctx, 1000));

    const { rows } = await db.query<{ type: string; actor_login: string }>("SELECT type, actor_login FROM feedback_events");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: "reaction", actor_login: "dev" });
  });
});
