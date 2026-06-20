import type { FeedbackEvent } from "@gate/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/app.js";
import {
  createInMemoryConsumedStore,
  mintFeedbackToken,
  verifyFeedbackToken,
} from "../src/feedback-token.js";
import { parseDesignReviewCommand, registerFeedbackRoutes } from "../src/feedback-routes.js";

const SECRET = "feedback-secret";
const basePayload = {
  type: "reaction" as const,
  installationId: "inst_1",
  owner: "acme",
  name: "web",
  prNumber: 42,
  headSha: "abc",
  findingId: "f_001",
  exp: 9_999_999_999_999,
};

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("feedback tokens", () => {
  it("round-trips and rejects tampering, wrong secret, and expiry", () => {
    const token = mintFeedbackToken(basePayload, SECRET);
    expect(verifyFeedbackToken(token, SECRET).ok).toBe(true);
    expect(verifyFeedbackToken(token, "other").ok).toBe(false);
    expect(verifyFeedbackToken(token + "x", SECRET).ok).toBe(false);
    const expired = mintFeedbackToken({ ...basePayload, exp: 1000 }, SECRET);
    expect(verifyFeedbackToken(expired, SECRET, 2000)).toMatchObject({ ok: false, reason: "expired" });
  });

  it("is single-use", async () => {
    const store = createInMemoryConsumedStore();
    expect(await store.consume("jti-1")).toBe(true);
    expect(await store.consume("jti-1")).toBe(false);
  });
});

describe("feedback routes", () => {
  function setup() {
    const recorded: FeedbackEvent[] = [];
    const sink = { record: vi.fn(async (e: FeedbackEvent) => void recorded.push(e)) };
    app = buildServer();
    registerFeedbackRoutes(app, { secret: SECRET, sink });
    return { recorded, sink };
  }

  it("GET prefetch is inert: /feedback is 405 and the confirm page records nothing", async () => {
    const { sink } = setup();
    expect((await app!.inject({ method: "GET", url: "/feedback" })).statusCode).toBe(405);

    const token = mintFeedbackToken(basePayload, SECRET);
    const confirm = await app!.inject({ method: "GET", url: `/feedback/confirm?token=${token}` });
    expect(confirm.statusCode).toBe(200);
    expect(confirm.headers["content-type"]).toContain("text/html");
    expect(sink.record).not.toHaveBeenCalled(); // GET mutates nothing
  });

  it("POST with a valid token records the feedback once (one-time)", async () => {
    const { sink } = setup();
    const token = mintFeedbackToken(basePayload, SECRET);

    const first = await app!.inject({ method: "POST", url: "/feedback", payload: { token } });
    expect(first.statusCode).toBe(200);
    expect(sink.record).toHaveBeenCalledOnce();

    const replay = await app!.inject({ method: "POST", url: "/feedback", payload: { token } });
    expect(replay.statusCode).toBe(409); // already_used
    expect(sink.record).toHaveBeenCalledOnce();
  });

  it("POST with a bad token is rejected and records nothing", async () => {
    const { sink } = setup();
    const res = await app!.inject({ method: "POST", url: "/feedback", payload: { token: "garbage" } });
    expect(res.statusCode).toBe(400);
    expect(sink.record).not.toHaveBeenCalled();
  });

  it("accepts urlencoded form posts (the confirm page form)", async () => {
    const { sink } = setup();
    const token = mintFeedbackToken(basePayload, SECRET);
    const res = await app!.inject({
      method: "POST",
      url: "/feedback",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: `token=${encodeURIComponent(token)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(sink.record).toHaveBeenCalledOnce();
  });
});

describe("parseDesignReviewCommand", () => {
  it("parses a slash command with args", () => {
    expect(parseDesignReviewCommand("/design-review ignore f_001")).toEqual({
      command: "ignore",
      args: ["f_001"],
    });
    expect(parseDesignReviewCommand("just a comment")).toBeNull();
  });
});
