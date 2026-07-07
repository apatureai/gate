import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SqlExecutor } from "./executor.js";

/** Directory holding ordered `NNNN_*.sql` migration files (sibling of dist). */
export const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

/**
 * Apply all pending migrations in lexical filename order, exactly once each.
 *
 * Tracking lives in `schema_migrations`; already-applied files are skipped, and
 * each file plus its marker insert runs in one transaction. A failed migration
 * rolls back both its DDL/DML and the marker, so a later deploy never sees a
 * partially-applied-but-untracked file as successful.
 * Returns the filenames applied this run (empty when nothing was pending).
 */
export async function runMigrations(
  exec: SqlExecutor,
  dir: string = MIGRATIONS_DIR,
): Promise<string[]> {
  await exec.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       id         text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     );`,
  );

  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const applied: string[] = [];
  for (const file of files) {
    const { rows } = await exec.query<{ id: string }>(
      "SELECT id FROM schema_migrations WHERE id = $1",
      [file],
    );
    if (rows.length > 0) continue;

    const sql = readFileSync(join(dir, file), "utf8");
    await exec.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.query("INSERT INTO schema_migrations (id) VALUES ($1)", [file]);
    });
    applied.push(file);
  }

  return applied;
}
