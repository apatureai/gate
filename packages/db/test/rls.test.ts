import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { pgliteExecutor, pgliteTenantRunner, runMigrations, type TenantTxRunner } from "../src/index.js";

let db: PGlite;
let tenants: TenantTxRunner;

async function seedTenant(installationId: number): Promise<void> {
  await tenants.withTenant(installationId, async (q) => {
    await q("INSERT INTO installations (id, account_login, account_id) VALUES ($1, $2, $3)", [
      installationId,
      `acct${installationId}`,
      installationId * 10,
    ]);
    await q(
      "INSERT INTO runs (installation_id, repo_owner, repo_name, pr_number, head_sha, grade) VALUES ($1, $2, $3, $4, $5, $6)",
      [installationId, `acct${installationId}`, "web", 1, `sha${installationId}`, "ship"],
    );
  });
}

beforeEach(async () => {
  db = new PGlite();
  await runMigrations(pgliteExecutor(db));
  // PGlite's default client is a superuser, which bypasses RLS. Run the
  // isolation suite as a non-superuser role, mirroring the production app role.
  await db.exec(
    `CREATE ROLE gate_app NOSUPERUSER;
     GRANT USAGE ON SCHEMA public TO gate_app;
     GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO gate_app;`,
  );
  tenants = pgliteTenantRunner(db, { role: "gate_app" });
  await seedTenant(1);
  await seedTenant(2);
});

describe("RLS tenant isolation", () => {
  it("a tenant reads only its own runs", async () => {
    const rows = await tenants.withTenant(1, (q) =>
      q<{ installation_id: string }>("SELECT installation_id FROM runs"),
    );
    expect(rows.rows).toHaveLength(1);
    expect(String(rows.rows[0]?.installation_id)).toBe("1");
  });

  it("a tenant cannot update another tenant's rows", async () => {
    await tenants.withTenant(1, (q) => q("UPDATE runs SET grade = 'blocked'"));

    const tenant2 = await tenants.withTenant(2, (q) =>
      q<{ grade: string }>("SELECT grade FROM runs"),
    );
    expect(tenant2.rows).toHaveLength(1);
    expect(tenant2.rows[0]?.grade).toBe("ship"); // untouched by tenant 1
  });

  it("a tenant cannot insert rows for another tenant (WITH CHECK)", async () => {
    await expect(
      tenants.withTenant(1, (q) =>
        q(
          "INSERT INTO runs (installation_id, repo_owner, repo_name, pr_number, head_sha) VALUES ($1, $2, $3, $4, $5)",
          [2, "acct2", "web", 99, "evil"],
        ),
      ),
    ).rejects.toThrow();
  });

  it("default-denies when no tenant context is set", async () => {
    // As the app role with RLS active but no tenant GUC, the policy sees NULL
    // and returns nothing.
    const rows = await db.transaction(async (tx) => {
      await tx.query("SET LOCAL ROLE gate_app");
      return tx.query("SELECT * FROM runs");
    });
    expect(rows.rows).toHaveLength(0);
  });

  it("isolation holds for feedback_events too", async () => {
    await tenants.withTenant(1, (q) =>
      q(
        "INSERT INTO feedback_events (installation_id, type, repo_owner, repo_name, pr_number, head_sha) VALUES ($1, $2, $3, $4, $5, $6)",
        [1, "finding_posted", "acct1", "web", 1, "sha1"],
      ),
    );

    const seenByTwo = await tenants.withTenant(2, (q) =>
      q("SELECT * FROM feedback_events"),
    );
    expect(seenByTwo.rows).toHaveLength(0);
  });
});
