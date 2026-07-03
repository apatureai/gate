import type { SqlQuery } from "./runs.js";

export interface DashboardTenantRunner {
  withTenant<T>(installationId: string | number, fn: (query: SqlQuery) => Promise<T>): Promise<T>;
}

/**
 * Run a dashboard data read inside the tenant RLS context (#99). The caller has
 * already checked session access; this is the database backstop that sets
 * app.current_installation_id transaction-locally through the shared runner.
 */
export async function withDashboardTenant<T>(
  runner: DashboardTenantRunner,
  installationId: string | number,
  fn: (query: SqlQuery) => Promise<T>,
): Promise<T> {
  if (installationId === "" || installationId === null || installationId === undefined) {
    throw new Error("dashboard tenant query requires an installation id");
  }
  return runner.withTenant(installationId, fn);
}
