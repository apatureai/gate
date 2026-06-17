import { describe, expect, it } from "vitest";
import {
  chooseReviewDepth,
  createInMemoryFullReviewWindow,
  decideDepthForPush,
  FULL_REVIEW_WINDOW_MS,
} from "../src/review-window.js";

const repo = { owner: "acme", name: "web", prNumber: 42 };

describe("chooseReviewDepth", () => {
  it("is deep when no full review has run", () => {
    expect(chooseReviewDepth(null, 1_000_000)).toBe("deep");
  });

  it("is triage inside the 10-minute window, deep after", () => {
    const now = 1_000_000;
    expect(chooseReviewDepth(now - 1_000, now)).toBe("triage"); // 1s ago
    expect(chooseReviewDepth(now - (FULL_REVIEW_WINDOW_MS - 1), now)).toBe("triage"); // just inside
    expect(chooseReviewDepth(now - FULL_REVIEW_WINDOW_MS, now)).toBe("deep"); // exactly at the edge
    expect(chooseReviewDepth(now - (FULL_REVIEW_WINDOW_MS + 1), now)).toBe("deep"); // outside
  });
});

describe("per-PR window store", () => {
  it("first push is deep; re-pushes within the window are triage; after the window deep again", async () => {
    const store = createInMemoryFullReviewWindow();
    const t0 = 1_000_000;

    expect(await decideDepthForPush(store, repo, t0)).toBe("deep");
    await store.recordFullReview(repo, t0); // a full review ran

    expect(await decideDepthForPush(store, repo, t0 + 60_000)).toBe("triage"); // 1 min later
    expect(await decideDepthForPush(store, repo, t0 + FULL_REVIEW_WINDOW_MS + 1)).toBe("deep");
  });

  it("tracks the window per PR independently", async () => {
    const store = createInMemoryFullReviewWindow();
    const t0 = 1_000_000;
    await store.recordFullReview(repo, t0);
    const otherPr = { owner: "acme", name: "web", prNumber: 7 };
    expect(await decideDepthForPush(store, otherPr, t0 + 1_000)).toBe("deep"); // unaffected
    expect(await decideDepthForPush(store, repo, t0 + 1_000)).toBe("triage");
  });
});
