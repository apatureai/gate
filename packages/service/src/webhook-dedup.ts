import type { SqlQuery } from "./review-window.js";

/**
 * Webhook delivery dedup (TRD §5, §15.4). GitHub delivers at-least-once, so the
 * `X-GitHub-Delivery` id is recorded before enqueue; a duplicate returns 200 and
 * skips. Backed by `webhook_log(delivery_id PRIMARY KEY)` (#33).
 */
export interface WebhookDedupeStore {
  /** Returns true if this delivery was already seen (duplicate → skip). */
  seenDelivery(deliveryId: string): Promise<boolean>;
}

export function createInMemoryWebhookDedupe(): WebhookDedupeStore {
  const seen = new Set<string>();
  return {
    async seenDelivery(deliveryId) {
      if (seen.has(deliveryId)) return true;
      seen.add(deliveryId);
      return false;
    },
  };
}

/**
 * Postgres dedup: insert the delivery id; the PRIMARY KEY makes a duplicate a
 * no-op (`ON CONFLICT DO NOTHING`), so a returned row means "new", none means
 * "duplicate".
 */
export function createSqlWebhookDedupe(query: SqlQuery): WebhookDedupeStore {
  return {
    async seenDelivery(deliveryId) {
      const { rows } = await query<{ delivery_id: string }>(
        `INSERT INTO webhook_log (delivery_id) VALUES ($1)
           ON CONFLICT (delivery_id) DO NOTHING
           RETURNING delivery_id`,
        [deliveryId],
      );
      return rows.length === 0;
    },
  };
}
