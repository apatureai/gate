import { Pool } from "pg";
import { withDashboardTenant, type SqlQuery } from "@gate/dashboard";
import { pgTenantRunner } from "@gate/db/tenant";

/**
 * Postgres adapter exposing the core's `SqlQuery` seam. The dashboard core
 * (`listRunHistory`, `loadFeedbackEvents`, billing store) is written against
 * this interface, so the app only supplies a connection. The app role must be a
 * non-superuser without BYPASSRLS so tenant RLS (#50) holds, defense in depth
 * with the edge `assertInstallationAccess` guard.
 */
let pool: Pool | undefined;

function getPool(): Pool {
  pool ??= new Pool({ connectionString: process.env.DATABASE_URL });
  return pool;
}

export function withTenantQuery<T>(
  installationId: string | number,
  fn: (query: SqlQuery) => Promise<T>,
): Promise<T> {
  return withDashboardTenant(pgTenantRunner(getPool()), installationId, fn);
}
