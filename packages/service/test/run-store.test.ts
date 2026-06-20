import { PGlite } from "@electric-sql/pglite";
import { pgliteExecutor, runMigrations } from "@gate/db";
import { beforeEach, describe, expect, it } from "vitest";
import { createSqlFullReviewWindow, decideDepthForPush } from "../src/review-window.js";
import { createSqlRunStore, type CompletedRunRecord } from "../src/run-store.js";

let db: PGlite;
const query = (sql: string, params?: unknown[]) => db.query(sql, params as unknown[]);
const repo = { owner: "acme", name: "web", prNumber: 42 };

const run = (over: Partial<CompletedRunRecord> = {}): CompletedRunRecord => ({
  installationId: "1",
  owner: "acme",
  name: "web",
  prNumber: 42,
  headSha: "abc",
  grade: "needs_work",
  depth: "deep",
  engineVersion: "1.0.0",
  model: "qwen3-vl-plus",
  uiDnaVersion: null,
  ...over,
});

beforeEach(async () => {
  db = new PGlite();
  await runMigrations(pgliteExecutor(db));
  await db.exec("INSERT INTO installations (id, account_login, account_id) VALUES (1, 'acme', 10)");
});

describe("createSqlRunStore (#69)", () => {
  it("persists a completed deep review with lineage + the full-review timestamp", async () => {
    const store = createSqlRunStore(query);
    await store.recordCompletedRun(run({ lastFullReviewAtMs: 1_000_000 }));

    const { rows } = await db.query<{ grade: string; model: string; depth: string; last_full_review_at: string | null }>(
      "SELECT grade, model, depth, last_full_review_at FROM runs",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ grade: "needs_work", model: "qwen3-vl-plus", depth: "deep" });
    expect(rows[0]?.last_full_review_at).not.toBeNull();
  });

  it("is idempotent on the completed-review identity (no duplicate row on retry)", async () => {
    const store = createSqlRunStore(query);
    await store.recordCompletedRun(run({ grade: "needs_work", lastFullReviewAtMs: 1_000_000 }));
    await store.recordCompletedRun(run({ grade: "ship_with_nits", lastFullReviewAtMs: 2_000_000 }));

    const { rows } = await db.query<{ grade: string }>("SELECT grade FROM runs");
    expect(rows).toHaveLength(1); // upsert, not a second row
    expect(rows[0]?.grade).toBe("ship_with_nits"); // refreshed metadata
  });

  it("makes the deep full-review window durable — a later push selects triage, even on a fresh store instance", async () => {
    const at = Date.now();
    await createSqlRunStore(query).recordCompletedRun(run({ lastFullReviewAtMs: at }));

    // Simulate a process restart: a brand-new window store over the same db.
    const window = createSqlFullReviewWindow(query);
    const decision = await decideDepthForPush(window, repo, at + 60_000); // 1 min later
    expect(decision).toBe("triage"); // within the 10-min cap, durably
  });

  it("a triage upsert does not clear a prior deep full-review timestamp (COALESCE)", async () => {
    const store = createSqlRunStore(query);
    await store.recordCompletedRun(run({ depth: "deep", lastFullReviewAtMs: 5_000_000 }));
    await store.recordCompletedRun(run({ depth: "triage", lastFullReviewAtMs: undefined }));

    const { rows } = await db.query<{ last_full_review_at: string | null; depth: string }>(
      "SELECT last_full_review_at, depth FROM runs",
    );
    expect(rows[0]?.depth).toBe("triage"); // metadata refreshed
    expect(rows[0]?.last_full_review_at).not.toBeNull(); // but the deep timestamp survives
  });
});
