import type { Tier } from "./scheduling.js";
import type { SqlQuery } from "./review-window.js";

/**
 * Tenant offboarding + crypto-shredding (TRD §8, §15.6; PRD §10). On
 * `installation.deleted` (or a dashboard action), delete the tenant's rows and,
 * for paid/enterprise, destroy the per-tenant CMK so artifacts encrypted under
 * it are crypto-shredded. Free tier shares a CMK, so deletion is the mechanism.
 * Every offboarding is audited with a timestamp for the DPA trail.
 */
export interface DeletedRowCounts {
  runs: number;
  feedback: number;
}

export interface TenantDeleter {
  deleteTenantRows(installationId: string): Promise<DeletedRowCounts>;
}

/** Postgres tenant deleter; explicit deletes give auditable per-table counts. */
export function createSqlTenantDeleter(query: SqlQuery): TenantDeleter {
  return {
    async deleteTenantRows(installationId) {
      const id = Number(installationId);
      const feedback = await query<{ id: string }>(
        "DELETE FROM feedback_events WHERE installation_id = $1 RETURNING id",
        [id],
      );
      const runs = await query<{ id: string }>("DELETE FROM runs WHERE installation_id = $1 RETURNING id", [id]);
      await query("DELETE FROM billing_customers WHERE installation_id = $1", [id]);
      await query("DELETE FROM installations WHERE id = $1", [id]);
      return { runs: runs.rows.length, feedback: feedback.rows.length };
    },
  };
}

export interface OffboardingAuditEntry {
  installationId: string;
  tier: Tier;
  deletedRows: DeletedRowCounts;
  cryptoShredded: boolean;
  at: string;
}

export interface OffboardingDeps {
  deleter: TenantDeleter;
  tier(installationId: string): Tier | Promise<Tier>;
  /** Destroy the per-tenant CMK (paid/enterprise only). */
  destroyTenantKey?(keyId: string): Promise<void>;
  /** Expire the tenant's stable screenshot routes so /i/<id> 410s afterward. */
  expireArtifacts?(installationId: string): Promise<void>;
  /** Audit sink (DPA trail). */
  audit(entry: OffboardingAuditEntry): void;
  now?: () => number;
}

export async function offboardTenant(
  installationId: string,
  tenantKeyId: string,
  deps: OffboardingDeps,
): Promise<OffboardingAuditEntry> {
  const now = deps.now ?? Date.now;
  const tier = await deps.tier(installationId);

  const deletedRows = await deps.deleter.deleteTenantRows(installationId);

  // Crypto-shred the per-tenant CMK for paid/enterprise; free tier shares a CMK.
  let cryptoShredded = false;
  if (tier !== "free" && deps.destroyTenantKey) {
    await deps.destroyTenantKey(tenantKeyId);
    cryptoShredded = true;
  }

  await deps.expireArtifacts?.(installationId);

  const entry: OffboardingAuditEntry = {
    installationId,
    tier,
    deletedRows,
    cryptoShredded,
    at: new Date(now()).toISOString(),
  };
  deps.audit(entry);
  return entry;
}
