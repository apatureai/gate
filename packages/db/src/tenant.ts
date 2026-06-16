import type { Pool } from "pg";

/**
 * Per-request tenant context for row-level security (#50).
 *
 * Every tenant-scoped query must run inside `withTenant`, which opens a
 * transaction and sets the transaction-local GUC `app.current_installation_id`
 * via `set_config(..., true)`. The RLS policies in 0002_rls.sql read that GUC,
 * so isolation is always active and default-denies when it is unset.
 */
export const TENANT_GUC = "app.current_installation_id";

export type QueryFn = <T = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
) => Promise<{ rows: T[] }>;

export interface TenantTxRunner {
  /** Run `fn` in a transaction scoped to `installationId` via RLS. */
  withTenant<T>(installationId: string | number, fn: (q: QueryFn) => Promise<T>): Promise<T>;
}

export interface TenantRunnerOptions {
  /**
   * Optional non-superuser role to `SET LOCAL ROLE` for the transaction. In
   * production the pool already connects as the app role, so this is unset;
   * tests use it because the default client is a superuser (which bypasses RLS).
   */
  role?: string;
}

function assertSafeRole(role: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(role)) {
    throw new Error(`Unsafe role identifier: ${role}`);
  }
  return role;
}

interface PgliteQueryable {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

interface PgliteTransactional {
  transaction<T>(callback: (tx: PgliteQueryable) => Promise<T>): Promise<T>;
}

/** Tenant runner over embedded PGlite (tests). */
export function pgliteTenantRunner(
  db: PgliteTransactional,
  options: TenantRunnerOptions = {},
): TenantTxRunner {
  const role = options.role ? assertSafeRole(options.role) : undefined;
  return {
    async withTenant(installationId, fn) {
      return db.transaction(async (tx) => {
        if (role) await tx.query(`SET LOCAL ROLE ${role}`);
        await tx.query("SELECT set_config($1, $2, true)", [TENANT_GUC, String(installationId)]);
        const q: QueryFn = (sql, params) => tx.query(sql, params);
        return fn(q);
      });
    },
  };
}

/** Tenant runner over a node-postgres Pool (deploy/runtime). */
export function pgTenantRunner(pool: Pool, options: TenantRunnerOptions = {}): TenantTxRunner {
  const role = options.role ? assertSafeRole(options.role) : undefined;
  return {
    async withTenant(installationId, fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        if (role) await client.query(`SET LOCAL ROLE ${role}`);
        await client.query("SELECT set_config($1, $2, true)", [TENANT_GUC, String(installationId)]);
        const q: QueryFn = async (sql, params) => {
          const result = await client.query(sql, params as unknown[] | undefined);
          return { rows: result.rows };
        };
        const out = await fn(q);
        await client.query("COMMIT");
        return out;
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    },
  };
}
