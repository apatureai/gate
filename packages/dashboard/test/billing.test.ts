import { createHmac } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { pgliteExecutor, runMigrations } from "@gate/db";
import { describe, expect, it } from "vitest";
import {
  canReviewRepo,
  computeMonthlyTotalCents,
  countDeepReviewsForPr,
  createSqlBillingStore,
  freeTierDepth,
  mapStripeEvent,
  PRICE_PER_SEAT_CENTS,
  verifyStripeSignature,
} from "../src/billing.js";

describe("pricing", () => {
  it("is $20/dev/mo", () => {
    expect(PRICE_PER_SEAT_CENTS).toBe(2000);
    expect(computeMonthlyTotalCents(5)).toBe(10_000);
  });
});

describe("verifyStripeSignature", () => {
  const secret = "whsec_test";
  const payload = JSON.stringify({ id: "evt_1" });
  const sign = (t: number) => `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex")}`;

  it("accepts a fresh valid signature, rejects tampering and stale timestamps", () => {
    const now = 1_000_000_000_000;
    const t = Math.floor(now / 1000);
    expect(verifyStripeSignature(payload, sign(t), secret, now)).toBe(true);
    expect(verifyStripeSignature("{}", sign(t), secret, now)).toBe(false); // tampered body
    expect(verifyStripeSignature(payload, sign(t - 10_000), secret, now)).toBe(false); // stale
  });

  it("accepts any matching v1 during secret rotation (multiple v1)", () => {
    const now = 1_000_000_000_000;
    const t = Math.floor(now / 1000);
    const good = createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");
    const header = `t=${t},v1=deadbeef,v1=${good}`; // an old/wrong sig plus the valid one
    expect(verifyStripeSignature(payload, header, secret, now)).toBe(true);
  });
});

describe("mapStripeEvent", () => {
  const meta = { metadata: { installation_id: "1" } };
  it("maps checkout/subscription events to billing updates", () => {
    expect(mapStripeEvent({ type: "checkout.session.completed", data: { object: { ...meta, customer: "cus_1" } } })).toEqual({
      installationId: "1",
      plan: "paid",
      status: "active",
      stripeCustomerId: "cus_1",
    });
    expect(mapStripeEvent({ type: "customer.subscription.deleted", data: { object: meta } })).toMatchObject({
      plan: "free",
      status: "canceled",
    });
    expect(mapStripeEvent({ type: "invoice.paid", data: { object: meta } })).toBeNull();
    expect(mapStripeEvent({ type: "checkout.session.completed", data: { object: {} } })).toBeNull(); // no installation_id
  });
});

describe("free-tier limits", () => {
  it("free tier is public-repos only", () => {
    expect(canReviewRepo("free", false)).toBe(true); // public
    expect(canReviewRepo("free", true)).toBe(false); // private
    expect(canReviewRepo("paid", true)).toBe(true);
  });

  it("free tier gets triage plus one deep review per PR", () => {
    expect(freeTierDepth("free", 0)).toBe("deep");
    expect(freeTierDepth("free", 1)).toBe("triage");
    expect(freeTierDepth("paid", 5)).toBeNull(); // normal depth policy applies
  });
});

describe("billing store + usage (real schema)", () => {
  it("upserts plan state and counts deep reviews per PR", async () => {
    const db = new PGlite();
    await runMigrations(pgliteExecutor(db));
    await db.exec("INSERT INTO installations (id, account_login, account_id) VALUES (1, 'acme', 10)");
    const query = (sql: string, params?: unknown[]) => db.query(sql, params as unknown[]);

    const store = createSqlBillingStore(query);
    await store.upsert({ installationId: "1", plan: "paid", status: "active", stripeCustomerId: "cus_1" });
    expect(await store.get("1")).toEqual({ plan: "paid", status: "active" });
    await store.upsert({ installationId: "1", status: "canceled", plan: "free" });
    expect(await store.get("1")).toEqual({ plan: "free", status: "canceled" });

    await db.query(
      "INSERT INTO runs (installation_id, repo_owner, repo_name, pr_number, head_sha, depth) VALUES (1,'acme','web',42,'s1','deep')",
    );
    await db.query(
      "INSERT INTO runs (installation_id, repo_owner, repo_name, pr_number, head_sha, depth) VALUES (1,'acme','web',42,'s2','triage')",
    );
    expect(await countDeepReviewsForPr(query, { owner: "acme", name: "web", prNumber: 42 })).toBe(1);
  });
});

describe("mapStripeEvent — subscription.updated transitions", () => {
  const meta = { metadata: { installation_id: "1" } };
  it("drops to free when an update reports canceled/unpaid", () => {
    expect(mapStripeEvent({ type: "customer.subscription.updated", data: { object: { ...meta, status: "canceled" } } })).toMatchObject({
      plan: "free",
      status: "canceled",
    });
    expect(mapStripeEvent({ type: "customer.subscription.updated", data: { object: { ...meta, status: "unpaid" } } })).toMatchObject({
      plan: "free",
      status: "canceled",
    });
  });
  it("stays paid for active / past_due (incl. cancel_at_period_end)", () => {
    expect(mapStripeEvent({ type: "customer.subscription.updated", data: { object: { ...meta, status: "active", cancel_at_period_end: true } } })).toMatchObject({
      plan: "paid",
      status: "active",
    });
    expect(mapStripeEvent({ type: "customer.subscription.updated", data: { object: { ...meta, status: "past_due" } } })).toMatchObject({
      plan: "paid",
      status: "past_due",
    });
  });
});
