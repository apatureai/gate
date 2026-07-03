import type { SqlQuery } from "./review-window.js";

/**
 * Webhook delivery dedup (TRD §5, §15.4). GitHub delivers at-least-once, so the
 * `X-GitHub-Delivery` id is reserved before dispatch; a duplicate returns 200 and
 * skips. If dispatch fails, the reservation is released so GitHub's retry can
 * recover. Backed by `webhook_log(delivery_id PRIMARY KEY)` (#33).
 */
export interface WebhookDedupeStore {
  /** Returns true if this delivery was already seen (duplicate → skip). */
  seenDelivery(deliveryId: string): Promise<boolean>;
  /** Release a previously-new delivery after handler failure so a retry can run. */
  releaseDelivery(deliveryId: string): Promise<void>;
}

export function createInMemoryWebhookDedupe(): WebhookDedupeStore {
  const seen = new Set<string>();
  return {
    async seenDelivery(deliveryId) {
      if (seen.has(deliveryId)) return true;
      seen.add(deliveryId);
      return false;
    },
    async releaseDelivery(deliveryId) {
      seen.delete(deliveryId);
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
    async releaseDelivery(deliveryId) {
      await query("DELETE FROM webhook_log WHERE delivery_id = $1", [deliveryId]);
    },
  };
}
