import { PGlite } from "@electric-sql/pglite";
import { pgliteExecutor, runMigrations } from "@gate/db";
import { InMemoryTenantKms, sealSecret, openSecret } from "@gate/secrets";
import { describe, expect, it, vi } from "vitest";
import {
  createSqlTenantDeleter,
  offboardTenant,
  type OffboardingAuditEntry,
  type TenantDeleter,
} from "../src/offboarding.js";

const noRows = { runs: 0, feedback: 0 };
const fakeDeleter = (counts = noRows): TenantDeleter => ({ deleteTenantRows: vi.fn(async () => counts) });

describe("offboardTenant", () => {
  it("free tier: deletes rows, no crypto-shred, audits with a timestamp", async () => {
    const audit: OffboardingAuditEntry[] = [];
    const destroyTenantKey = vi.fn(async () => {});
    const entry = await offboardTenant("1", "tenant:1", {
      deleter: fakeDeleter({ runs: 3, feedback: 5 }),
      tier: () => "free",
      destroyTenantKey,
      audit: (e) => audit.push(e),
      now: () => 1_700_000_000_000,
    });
    expect(entry.deletedRows).toEqual({ runs: 3, feedback: 5 });
    expect(entry.cryptoShredded).toBe(false);
    expect(destroyTenantKey).not.toHaveBeenCalled(); // shared CMK on free tier
    expect(entry.at).toBe(new Date(1_700_000_000_000).toISOString());
    expect(audit).toHaveLength(1);
  });

  it("enterprise: crypto-shreds the per-tenant CMK and expires artifacts", async () => {
    const destroyTenantKey = vi.fn(async () => {});
    const expireArtifacts = vi.fn(async () => {});
    const entry = await offboardTenant("2", "tenant:2", {
      deleter: fakeDeleter(),
      tier: () => "enterprise",
      destroyTenantKey,
      expireArtifacts,
      audit: () => {},
    });
    expect(entry.cryptoShredded).toBe(true);
    expect(destroyTenantKey).toHaveBeenCalledWith("tenant:2");
    expect(expireArtifacts).toHaveBeenCalledWith("2");
  });
});

describe("crypto-shredding makes artifacts unrecoverable", () => {
  it("openSecret fails after the tenant key is destroyed", async () => {
    const kms = new InMemoryTenantKms();
    const sealed = await sealSecret("storage-state-blob", "tenant:2", kms);
    expect(await openSecret(sealed, kms)).toBe("storage-state-blob");

    await offboardTenant("2", "tenant:2", {
      deleter: fakeDeleter(),
      tier: () => "business",
      destroyTenantKey: (keyId) => kms.destroyTenantKey(keyId),
      audit: () => {},
    });
    await expect(openSecret(sealed, kms)).rejects.toThrow(/crypto-shredded/);
  });
});

describe("createSqlTenantDeleter", () => {
  it("deletes the tenant's rows (and cascades) on the real schema", async () => {
    const db = new PGlite();
    await runMigrations(pgliteExecutor(db));
    await db.exec("INSERT INTO installations (id, account_login, account_id) VALUES (9, 'acme', 90)");
    await db.query(
      "INSERT INTO runs (installation_id, repo_owner, repo_name, pr_number, head_sha) VALUES (9, 'acme', 'web', 1, 's1')",
    );
    await db.query(
      "INSERT INTO feedback_events (installation_id, type, repo_owner, repo_name, pr_number, head_sha) VALUES (9, 'reaction', 'acme', 'web', 1, 's1')",
    );

    const deleter = createSqlTenantDeleter((sql, params) => db.query(sql, params as unknown[]));
    const counts = await deleter.deleteTenantRows("9");
    expect(counts).toEqual({ runs: 1, feedback: 1 });

    const remaining = await db.query<{ count: string }>("SELECT count(*)::text AS count FROM installations WHERE id = 9");
    expect(remaining.rows[0]?.count).toBe("0");
  });
});
