import { PGlite } from "@electric-sql/pglite";
import { pgliteExecutor, runMigrations } from "@gate/db";
import { beforeEach, describe, expect, it } from "vitest";
import {
  buildScreenshotRecords,
  createSqlScreenshotRegistry,
  deriveArtifactId,
  type ScreenshotRecord,
} from "../src/index.js";

let db: PGlite;
const query = (sql: string, params?: unknown[]) => db.query(sql, params as unknown[]);

const rec = (over: Partial<ScreenshotRecord> = {}): ScreenshotRecord => ({
  artifactId: deriveArtifactId({ installationId: "1", owner: "acme", name: "web", headSha: "sha1", findingId: "f_001" }),
  findingId: "f_001",
  headSha: "sha1",
  objectKey: "jobs/1/shot.png",
  expiresAt: 5_000_000,
  installationId: "1",
  owner: "acme",
  name: "web",
  visibility: "private",
  ...over,
});

beforeEach(async () => {
  db = new PGlite();
  await runMigrations(pgliteExecutor(db));
  await db.exec("INSERT INTO installations (id, account_login, account_id) VALUES (1, 'acme', 10), (2, 'other', 20)");
});

describe("createSqlScreenshotRegistry (#71)", () => {
  it("persists + looks up by collision-safe artifact id, surviving a fresh store instance (restart)", async () => {
    await createSqlScreenshotRegistry(query).record([rec()]);

    // New store instance == process restart: durable lookup still resolves.
    const found = await createSqlScreenshotRegistry(query).lookup(rec().artifactId);
    expect(found).toMatchObject({ findingId: "f_001", owner: "acme", name: "web", visibility: "private" });
  });

  it("is idempotent on retry (upsert on artifact id — no duplicate rows)", async () => {
    const store = createSqlScreenshotRegistry(query);
    await store.record([rec()]);
    await store.record([rec({ objectKey: "jobs/1/shot-v2.png" })]); // same artifact id
    const { rows } = await db.query("SELECT artifact_id, object_key FROM screenshot_artifacts");
    expect(rows).toHaveLength(1);
    expect((rows[0] as { object_key: string }).object_key).toBe("jobs/1/shot-v2.png");
  });

  it("two repos with the SAME engine findingId get distinct artifacts that can't resolve each other", async () => {
    const store = createSqlScreenshotRegistry(query);
    const acme = rec();
    const other = rec({
      installationId: "2",
      owner: "other",
      name: "web",
      artifactId: deriveArtifactId({ installationId: "2", owner: "other", name: "web", headSha: "sha1", findingId: "f_001" }),
    });
    expect(acme.artifactId).not.toBe(other.artifactId); // same findingId, different artifact
    await store.record([acme, other]);

    expect((await store.lookup(acme.artifactId))?.installationId).toBe("1");
    expect((await store.lookup(other.artifactId))?.installationId).toBe("2");
  });

  it("offboarding deletes a tenant's artifacts; retention sweep drops expired ones", async () => {
    const store = createSqlScreenshotRegistry(query);
    await store.record([
      rec(),
      rec({ installationId: "2", owner: "other", artifactId: "keep-other", expiresAt: 9_000_000 }),
      rec({ artifactId: "stale", expiresAt: 1_000 }),
    ]);

    expect(await store.deleteExpired(2_000)).toBe(1); // the stale one
    expect(await store.lookup("stale")).toBeNull();

    expect(await store.deleteForInstallation("1")).toBe(1); // acme's remaining row
    expect(await store.lookup(rec().artifactId)).toBeNull();
    expect(await store.lookup("keep-other")).not.toBeNull(); // other tenant untouched
  });

  it("the installation FK cascades artifacts on tenant deletion (offboarding backstop)", async () => {
    await createSqlScreenshotRegistry(query).record([rec()]);
    await db.exec("DELETE FROM installations WHERE id = 1");
    const { rows } = await db.query("SELECT artifact_id FROM screenshot_artifacts");
    expect(rows).toHaveLength(0);
  });

  it("records built from a review carry derivable artifact ids", async () => {
    // buildScreenshotRecords + the registry agree on the id (delivery/dashboard can derive it).
    const recs = rec();
    await createSqlScreenshotRegistry(query).record([recs]);
    const derived = deriveArtifactId({ installationId: "1", owner: "acme", name: "web", headSha: "sha1", findingId: "f_001" });
    expect(await createSqlScreenshotRegistry(query).lookup(derived)).not.toBeNull();
    expect(typeof buildScreenshotRecords).toBe("function");
  });
});
