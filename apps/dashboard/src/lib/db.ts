import { Pool } from "pg";
import type { SqlQuery } from "@gate/dashboard";

/**
 * Postgres adapter exposing the core's `SqlQuery` seam. The dashboard core
 * (`listRunHistory`, `loadFeedbackEvents`, billing store) is written against
 * this interface, so the app only supplies a connection. The app role must be a
 * non-superuser without BYPASSRLS so tenant RLS (#50) holds — defense in depth
 * with the edge `assertInstallationAccess` guard.
 */
let pool: Pool | undefined;

function getPool(): Pool {
  pool ??= new Pool({ connectionString: process.env.DATABASE_URL });
  return pool;
}

export function getQuery(): SqlQuery {
  const p = getPool();
  return async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
    const res = await p.query(sql, params as unknown[] | undefined);
    return { rows: res.rows as T[] };
  };
}
