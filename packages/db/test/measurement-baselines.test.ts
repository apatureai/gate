import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { pgliteExecutor, pgliteTenantRunner, runMigrations, type TenantTxRunner } from "../src/index.js";

/**
 * The table that lets a pull request be told apart from its own back catalogue.
 *
 * Everything here is about a claim the schema has to make impossible: that a
 * commit Gate has never measured looks the same as a commit Gate measured and
 * found clean. The identity constraint keeps one row per repository and commit,
 * the tenant policy keeps one installation's history out of another's, and the
 * cascade keeps an offboarded tenant's history from outliving them.
 */

let db: PGlite;

const insert = (installationId: number, owner: string, name: string, sha: string, entries = "[]") =>
  [
    `INSERT INTO measurement_baselines
       (installation_id, repo_owner, repo_name, commit_sha, fingerprint_version,
        checks_run, routes_measured, entries)
     VALUES ($1, $2, $3, $4, 'm1', '["contrast"]'::jsonb, '["/"]'::jsonb, $5::jsonb)`,
    [installationId, owner, name, sha, entries],
  ] as const;

beforeEach(async () => {
  db = new PGlite();
  await runMigrations(pgliteExecutor(db));
  await db.exec(
    "INSERT INTO installations (id, account_login, account_id) VALUES (1, 'acme', 10), (2, 'other', 20)",
  );
});

describe("measurement_baselines", () => {
  it("is created by the migration runner and is idempotent to re-apply", async () => {
    const names = await db.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
    );
    expect(names.rows.map((r) => r.table_name)).toContain("measurement_baselines");
    expect(await runMigrations(pgliteExecutor(db))).toEqual([]);
  });

  it("keeps one row per repository and commit", async () => {
    await db.query(...insert(1, "acme", "web", "sha1"));
    await expect(db.query(...insert(1, "acme", "web", "sha1"))).rejects.toThrow();
    // A different commit, a different repo and a different owner are all distinct.
    await expect(db.query(...insert(1, "acme", "web", "sha2"))).resolves.toBeDefined();
    await expect(db.query(...insert(1, "acme", "docs", "sha1"))).resolves.toBeDefined();
    await expect(db.query(...insert(2, "other", "web", "sha1"))).resolves.toBeDefined();
  });

  it("goes when its installation goes (offboarding)", async () => {
    await db.query(...insert(1, "acme", "web", "sha1"));
    await db.exec("DELETE FROM installations WHERE id = 1");

    const rows = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM measurement_baselines",
    );
    expect(rows.rows[0]?.count).toBe("0");
  });
});

describe("measurement_baselines tenant isolation", () => {
  let tenants: TenantTxRunner;

  beforeEach(async () => {
    // PGlite's default client is a superuser, which bypasses RLS. Run as a
    // non-superuser role, mirroring the production app role.
    await db.exec(
      `CREATE ROLE gate_app NOSUPERUSER;
       GRANT USAGE ON SCHEMA public TO gate_app;
       GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO gate_app;`,
    );
    tenants = pgliteTenantRunner(db, { role: "gate_app" });
    await tenants.withTenant(1, (q) => q(...insert(1, "acme", "web", "sha1")));
    await tenants.withTenant(2, (q) => q(...insert(2, "other", "web", "sha2")));
  });

  it("reads only its own baselines", async () => {
    const rows = await tenants.withTenant(1, (q) =>
      q<{ commit_sha: string }>("SELECT commit_sha FROM measurement_baselines"),
    );
    expect(rows.rows.map((r) => r.commit_sha)).toEqual(["sha1"]);
  });

  it("cannot write a baseline for another tenant (WITH CHECK)", async () => {
    await expect(
      tenants.withTenant(1, (q) => q(...insert(2, "other", "web", "sha9"))),
    ).rejects.toThrow();
  });

  it("default-denies with no tenant context set", async () => {
    await db.exec("SET ROLE gate_app");
    const rows = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM measurement_baselines",
    );
    await db.exec("RESET ROLE");
    expect(rows.rows[0]?.count).toBe("0");
  });
});
