import { PGlite } from "@electric-sql/pglite";
import { pgliteExecutor, runMigrations } from "@gate/db";
import { describe, expect, it } from "vitest";
import {
  classifyFeedback,
  computeFeedbackStats,
  feedbackTrend,
  type FeedbackLike,
  loadFeedbackEvents,
  statsByDimension,
} from "../src/stats.js";

describe("classifyFeedback", () => {
  it("maps event types/votes to sentiment", () => {
    expect(classifyFeedback({ type: "suggestion_adopted", createdAt: "" })).toBe("positive");
    expect(classifyFeedback({ type: "ignore_suppress", createdAt: "" })).toBe("negative");
    expect(classifyFeedback({ type: "merged_with_unresolved_blockers", createdAt: "" })).toBe("negative");
    expect(classifyFeedback({ type: "reaction", metadata: { vote: "up" }, createdAt: "" })).toBe("positive");
    expect(classifyFeedback({ type: "reaction", metadata: { vote: "down" }, createdAt: "" })).toBe("negative");
    expect(classifyFeedback({ type: "finding_posted", createdAt: "" })).toBe("neutral");
  });
});

const events: FeedbackLike[] = [
  { type: "suggestion_adopted", metadata: { severity: "major" }, createdAt: "2026-06-01T10:00:00Z" },
  { type: "ignore_suppress", metadata: { severity: "nit" }, createdAt: "2026-06-01T12:00:00Z" },
  { type: "reaction", metadata: { vote: "up", severity: "major" }, createdAt: "2026-06-02T09:00:00Z" },
  { type: "finding_posted", metadata: { severity: "major" }, createdAt: "2026-06-02T09:30:00Z" },
];

describe("computeFeedbackStats", () => {
  it("computes acceptance rate over decisive feedback", () => {
    const stats = computeFeedbackStats(events);
    expect(stats).toMatchObject({ positive: 2, negative: 1, neutral: 1, total: 4 });
    expect(stats.acceptanceRate).toBeCloseTo(2 / 3);
  });
});

describe("statsByDimension", () => {
  it("breaks rates down by a dimension", () => {
    const bySeverity = statsByDimension(events, (e) => (e.metadata?.["severity"] as string) ?? null);
    expect(bySeverity.major.acceptanceRate).toBe(1); // 2 positive, 0 negative
    expect(bySeverity.nit.acceptanceRate).toBe(0); // 1 negative
  });
});

describe("feedbackTrend", () => {
  it("buckets acceptance by day ascending", () => {
    const trend = feedbackTrend(events);
    expect(trend.map((t) => t.bucket)).toEqual(["2026-06-01", "2026-06-02"]);
    expect(trend[0]).toMatchObject({ positive: 1, negative: 1 });
  });
});

describe("loadFeedbackEvents", () => {
  it("loads a repo's feedback from the store", async () => {
    const db = new PGlite();
    await runMigrations(pgliteExecutor(db));
    await db.exec("INSERT INTO installations (id, account_login, account_id) VALUES (1, 'acme', 10)");
    await db.query(
      "INSERT INTO feedback_events (installation_id, type, repo_owner, repo_name, pr_number, head_sha, metadata) VALUES (1, 'suggestion_adopted', 'acme', 'web', 1, 's1', '{\"severity\":\"major\"}')",
    );
    const loaded = await loadFeedbackEvents((sql, params) => db.query(sql, params as unknown[]), {
      owner: "acme",
      name: "web",
    });
    expect(loaded).toHaveLength(1);
    expect(classifyFeedback(loaded[0]!)).toBe("positive");
    expect(loaded[0]!.metadata?.severity).toBe("major");
  });
});
