import { PGlite } from "@electric-sql/pglite";
import { pgliteExecutor, runMigrations } from "@gate/db";
import { beforeEach, describe, expect, it } from "vitest";
import { createSqlConsumedStore } from "../src/index.js";

let db: PGlite;
const query = (sql: string, params?: unknown[]) => db.query(sql, params as unknown[]);

beforeEach(async () => {
  db = new PGlite();
  await runMigrations(pgliteExecutor(db));
});

describe("createSqlConsumedStore (#13 single-use, CSO finding)", () => {
  it("first consume succeeds, replay of the same jti fails", async () => {
    const store = createSqlConsumedStore(query);
    expect(await store.consume("jti-1")).toBe(true);
    expect(await store.consume("jti-1")).toBe(false);
  });

  it("enforces single-use across instances (durable, not per-process)", async () => {
    // Two independent store instances over the SAME database = two app instances.
    const a = createSqlConsumedStore(query);
    const b = createSqlConsumedStore(query);
    expect(await a.consume("shared-jti")).toBe(true);
    expect(await b.consume("shared-jti")).toBe(false); // the other instance can't replay it
  });

  it("distinct jtis are independent", async () => {
    const store = createSqlConsumedStore(query);
    expect(await store.consume("a")).toBe(true);
    expect(await store.consume("b")).toBe(true);
  });
});
