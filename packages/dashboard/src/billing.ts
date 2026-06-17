import { createHmac, timingSafeEqual } from "node:crypto";
import type { SqlQuery } from "./runs.js";

/**
 * Billing for the CI Gate product (PRD §9): $20/dev/mo Stripe subscriptions and
 * enforced free-tier limits. Pure billing logic + a Postgres store; the Stripe
 * webhook route wires these. (MCP-review metering is out of scope — that's
 * apatureai/mcp-review.)
 */
export const PRICE_PER_SEAT_CENTS = 2000; // $20 / dev / month

export function computeMonthlyTotalCents(seats: number): number {
  return Math.max(0, Math.trunc(seats)) * PRICE_PER_SEAT_CENTS;
}

export type BillingPlan = "free" | "paid";
export type BillingStatus = "active" | "past_due" | "canceled";

/**
 * Verify a Stripe webhook signature (`Stripe-Signature: t=...,v1=...`). HMAC-SHA256
 * over `${t}.${payload}`, constant-time compared, with a timestamp tolerance.
 */
export function verifyStripeSignature(
  payload: string,
  signatureHeader: string,
  secret: string,
  now: number = Date.now(),
  toleranceSec = 300,
): boolean {
  const parts = Object.fromEntries(
    signatureHeader.split(",").map((kv) => {
      const [k, v] = kv.split("=");
      return [k?.trim(), v?.trim()];
    }),
  );
  const t = Number(parts["t"]);
  const v1 = parts["v1"];
  if (!Number.isFinite(t) || !v1) return false;
  if (Math.abs(now - t * 1000) > toleranceSec * 1000) return false;

  const expected = createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(v1);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface BillingUpdate {
  installationId: string;
  plan?: BillingPlan;
  status: BillingStatus;
  stripeCustomerId?: string;
}

interface StripeEvent {
  type: string;
  data: { object: Record<string, unknown> };
}

/** Map a Stripe event to a billing state update, or null if irrelevant. */
export function mapStripeEvent(event: StripeEvent): BillingUpdate | null {
  const obj = event.data.object;
  const metadata = (obj["metadata"] as Record<string, string> | undefined) ?? {};
  const installationId = metadata["installation_id"];
  if (!installationId) return null;

  switch (event.type) {
    case "checkout.session.completed":
      return {
        installationId,
        plan: "paid",
        status: "active",
        stripeCustomerId: typeof obj["customer"] === "string" ? obj["customer"] : undefined,
      };
    case "customer.subscription.updated": {
      const status = obj["status"] === "past_due" ? "past_due" : "active";
      return { installationId, plan: "paid", status };
    }
    case "customer.subscription.deleted":
      return { installationId, plan: "free", status: "canceled" };
    default:
      return null;
  }
}

/** Free tier is public-repos only. */
export function canReviewRepo(plan: BillingPlan, repoPrivate: boolean): boolean {
  return plan === "paid" || !repoPrivate;
}

/**
 * Free-tier depth cap: a PR gets triage plus exactly one deep review. Returns a
 * forced depth, or null when the normal depth policy (#43) applies (paid tier).
 */
export function freeTierDepth(plan: BillingPlan, deepReviewsUsedForPr: number): "triage" | "deep" | null {
  if (plan === "paid") return null;
  return deepReviewsUsedForPr === 0 ? "deep" : "triage";
}

export interface BillingStore {
  upsert(update: BillingUpdate): Promise<void>;
  get(installationId: string): Promise<{ plan: BillingPlan; status: BillingStatus } | null>;
}

export function createSqlBillingStore(query: SqlQuery): BillingStore {
  return {
    async upsert(update) {
      await query(
        `INSERT INTO billing_customers (installation_id, stripe_customer_id, plan, status, updated_at)
           VALUES ($1, $2, COALESCE($3, 'free'), $4, now())
         ON CONFLICT (installation_id) DO UPDATE SET
           stripe_customer_id = COALESCE(EXCLUDED.stripe_customer_id, billing_customers.stripe_customer_id),
           plan = COALESCE($3, billing_customers.plan),
           status = EXCLUDED.status,
           updated_at = now()`,
        [Number(update.installationId), update.stripeCustomerId ?? null, update.plan ?? null, update.status],
      );
    },
    async get(installationId) {
      const { rows } = await query<{ plan: BillingPlan; status: BillingStatus }>(
        "SELECT plan, status FROM billing_customers WHERE installation_id = $1",
        [Number(installationId)],
      );
      return rows[0] ?? null;
    },
  };
}

/** Usage recorded for billing is the run history; count deep reviews per PR. */
export async function countDeepReviewsForPr(
  query: SqlQuery,
  params: { owner: string; name: string; prNumber: number },
): Promise<number> {
  const { rows } = await query<{ count: string }>(
    `SELECT count(*)::text AS count FROM runs
       WHERE repo_owner = $1 AND repo_name = $2 AND pr_number = $3 AND depth = 'deep'`,
    [params.owner, params.name, params.prNumber],
  );
  return Number(rows[0]?.count ?? 0);
}

/** Total reviews recorded for a repo (billing usage), optionally since a date. */
export async function countReviewsForRepo(
  query: SqlQuery,
  params: { owner: string; name: string; since?: string },
): Promise<number> {
  const args: unknown[] = [params.owner, params.name];
  let sql = "SELECT count(*)::text AS count FROM runs WHERE repo_owner = $1 AND repo_name = $2";
  if (params.since) {
    args.push(params.since);
    sql += ` AND created_at >= $${args.length}`;
  }
  const { rows } = await query<{ count: string }>(sql, args);
  return Number(rows[0]?.count ?? 0);
}
