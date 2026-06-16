import type { Pool } from "pg";

/**
 * Minimal SQL executor the migration runner depends on. Abstracts over the real
 * `pg` Pool (deploy/runtime) and embedded PGlite (tests) so the same runner is
 * exercised in CI without provisioning a live database.
 */
export interface SqlExecutor {
  /** Run one or more statements with no parameters (used for migration files). */
  exec(sql: string): Promise<void>;
  /** Run a single parameterized statement and return rows. */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

/** Adapter over a node-postgres Pool for deploy/runtime. */
export function pgExecutor(pool: Pool): SqlExecutor {
  return {
    async exec(sql) {
      await pool.query(sql);
    },
    async query<T = Record<string, unknown>>(sql: string, params?: unknown[]) {
      const result = await pool.query(sql, params as unknown[] | undefined);
      return { rows: result.rows as T[] };
    },
  };
}

/** Shape of the embedded PGlite client we depend on (kept dependency-free). */
export interface PgliteLike {
  exec(sql: string): Promise<unknown>;
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

/** Adapter over an embedded PGlite instance for tests. */
export function pgliteExecutor(db: PgliteLike): SqlExecutor {
  return {
    async exec(sql) {
      await db.exec(sql);
    },
    async query<T = Record<string, unknown>>(sql: string, params?: unknown[]) {
      return db.query<T>(sql, params);
    },
  };
}
