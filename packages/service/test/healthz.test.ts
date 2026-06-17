import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/app.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("GET /healthz", () => {
  it("returns 200 ok for Fly health checks", async () => {
    app = buildServer();
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });
});
