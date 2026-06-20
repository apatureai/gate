import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, pgliteExecutor, runMigrations, TABLES } from "../src/index.js";

async function tableNames(db: PGlite): Promise<string[]> {
  const { rows } = await db.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
  );
  return rows.map((r) => r.table_name);
}

describe("runMigrations", () => {
  it("creates every product table and is idempotent", async () => {
    const db = new PGlite();
    const exec = pgliteExecutor(db);

    const firstRun = await runMigrations(exec);
    expect(firstRun).toContain("0001_init.sql");
    expect(firstRun).toContain("0003_scope_run_identity.sql");

    const names = await tableNames(db);
    expect(names).toEqual(expect.arrayContaining([...TABLES, "schema_migrations"]));

    // Re-running applies nothing.
    const secondRun = await runMigrations(exec);
    expect(secondRun).toEqual([]);
  });

  it("scopes the completed-review identity to repository + PR + head SHA", async () => {
    const db = new PGlite();
    await runMigrations(pgliteExecutor(db));

    await db.exec(
      "INSERT INTO installations (id, account_login, account_id) VALUES (1, 'acme', 10), (2, 'other', 20)",
    );
    await db.query(
      "INSERT INTO runs (installation_id, repo_owner, repo_name, pr_number, head_sha) VALUES (1, 'acme', 'web', 42, 'abc')",
    );

    await expect(
      db.query(
        "INSERT INTO runs (installation_id, repo_owner, repo_name, pr_number, head_sha) VALUES (2, 'other', 'web', 42, 'abc')",
      ),
    ).resolves.toBeDefined();

    await expect(
      db.query(
        "INSERT INTO runs (installation_id, repo_owner, repo_name, pr_number, head_sha) VALUES (1, 'acme', 'web', 42, 'abc')",
      ),
    ).rejects.toThrow();
  });

  it("preserves existing rows when applying the repository-scoping migration", async () => {
    const db = new PGlite();
    await db.exec(readFileSync(join(MIGRATIONS_DIR, "0001_init.sql"), "utf8"));
    await db.exec(
      "INSERT INTO installations (id, account_login, account_id) VALUES (1, 'acme', 10), (2, 'other', 20)",
    );
    await db.query(
      "INSERT INTO runs (installation_id, repo_owner, repo_name, pr_number, head_sha) VALUES (1, 'acme', 'web', 42, 'abc')",
    );

    const migration = readFileSync(join(MIGRATIONS_DIR, "0003_scope_run_identity.sql"), "utf8");
    await db.exec(migration);
    await db.exec(migration);

    const existing = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM runs WHERE repo_owner = 'acme' AND repo_name = 'web'",
    );
    expect(existing.rows[0]?.count).toBe("1");

    await expect(
      db.query(
        "INSERT INTO runs (installation_id, repo_owner, repo_name, pr_number, head_sha) VALUES (2, 'other', 'web', 42, 'abc')",
      ),
    ).resolves.toBeDefined();
  });

  it("cascades feedback_events and runs when an installation is removed (offboarding)", async () => {
    const db = new PGlite();
    await runMigrations(pgliteExecutor(db));

    await db.exec(
      "INSERT INTO installations (id, account_login, account_id) VALUES (1, 'acme', 10)",
    );
    await db.query(
      "INSERT INTO runs (id, installation_id, repo_owner, repo_name, pr_number, head_sha) VALUES ('11111111-1111-1111-1111-111111111111', 1, 'acme', 'web', 7, 'sha7')",
    );
    await db.query(
      "INSERT INTO feedback_events (installation_id, run_id, type, repo_owner, repo_name, pr_number, head_sha) VALUES (1, '11111111-1111-1111-1111-111111111111', 'finding_posted', 'acme', 'web', 7, 'sha7')",
    );

    await db.exec("DELETE FROM installations WHERE id = 1");

    const runs = await db.query<{ count: string }>("SELECT count(*)::text AS count FROM runs");
    const events = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM feedback_events",
    );
    expect(runs.rows[0]?.count).toBe("0");
    expect(events.rows[0]?.count).toBe("0");
  });
});
