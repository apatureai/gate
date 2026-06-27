import { PGlite } from "@electric-sql/pglite";
import { pgliteExecutor, runMigrations } from "@gate/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/app.js";
import { createInMemoryWebhookDedupe, createSqlWebhookDedupe } from "../src/webhook-dedup.js";

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("createInMemoryWebhookDedupe", () => {
  it("reports a delivery as new once, duplicate after", async () => {
    const dedupe = createInMemoryWebhookDedupe();
    expect(await dedupe.seenDelivery("d1")).toBe(false);
    expect(await dedupe.seenDelivery("d1")).toBe(true);
    expect(await dedupe.seenDelivery("d2")).toBe(false);
  });

  it("can release a failed reservation so a retry is new", async () => {
    const dedupe = createInMemoryWebhookDedupe();
    expect(await dedupe.seenDelivery("d1")).toBe(false);
    await dedupe.releaseDelivery("d1");
    expect(await dedupe.seenDelivery("d1")).toBe(false);
    expect(await dedupe.seenDelivery("d1")).toBe(true);
  });
});

describe("createSqlWebhookDedupe (webhook_log PRIMARY KEY)", () => {
  it("dedupes via ON CONFLICT on the real schema", async () => {
    const db = new PGlite();
    await runMigrations(pgliteExecutor(db));
    const dedupe = createSqlWebhookDedupe((sql, params) => db.query(sql, params as unknown[]));

    expect(await dedupe.seenDelivery("delivery-1")).toBe(false);
    expect(await dedupe.seenDelivery("delivery-1")).toBe(true); // conflict -> duplicate
    expect(await dedupe.seenDelivery("delivery-2")).toBe(false);
  });

  it("releases a failed reservation using the existing webhook_log table", async () => {
    const db = new PGlite();
    await runMigrations(pgliteExecutor(db));
    const dedupe = createSqlWebhookDedupe((sql, params) => db.query(sql, params as unknown[]));

    expect(await dedupe.seenDelivery("delivery-1")).toBe(false);
    await dedupe.releaseDelivery("delivery-1");
    expect(await dedupe.seenDelivery("delivery-1")).toBe(false);
    expect(await dedupe.seenDelivery("delivery-1")).toBe(true);
  });
});

describe("/webhook delivery dedup", () => {
  it("skips a re-delivered id with a 200 and does not dispatch twice", async () => {
    const onPullRequest = vi.fn();
    app = buildServer({ webhookDedupe: createInMemoryWebhookDedupe(), webhook: { onPullRequest } });
    const headers = { "x-github-event": "pull_request", "x-github-delivery": "dup-1" };

    const first = await app.inject({ method: "POST", url: "/webhook", headers, payload: { number: 1 } });
    expect(first.statusCode).toBe(202);

    const second = await app.inject({ method: "POST", url: "/webhook", headers, payload: { number: 1 } });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ duplicate: true });
    expect(onPullRequest).toHaveBeenCalledOnce();
  });

  it("does not consume a delivery id when the handler fails, so GitHub retry dispatches again", async () => {
    const onPullRequest = vi.fn()
      .mockRejectedValueOnce(new Error("temporary enqueue failure"))
      .mockResolvedValueOnce(undefined);
    app = buildServer({ webhookDedupe: createInMemoryWebhookDedupe(), webhook: { onPullRequest } });
    const headers = { "x-github-event": "pull_request", "x-github-delivery": "retry-1" };

    const first = await app.inject({ method: "POST", url: "/webhook", headers, payload: { number: 1 } });
    expect(first.statusCode).toBe(500);

    const retry = await app.inject({ method: "POST", url: "/webhook", headers, payload: { number: 1 } });
    expect(retry.statusCode).toBe(202);

    const duplicateAfterSuccess = await app.inject({ method: "POST", url: "/webhook", headers, payload: { number: 1 } });
    expect(duplicateAfterSuccess.statusCode).toBe(200);
    expect(duplicateAfterSuccess.json()).toEqual({ duplicate: true });
    expect(onPullRequest).toHaveBeenCalledTimes(2);
  });
});
