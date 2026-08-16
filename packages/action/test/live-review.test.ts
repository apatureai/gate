import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  fixturePreviewCommand,
  formatLiveReviewResult,
  LiveReviewConfigError,
  LiveReviewEndpointError,
  runLiveReview,
  type LiveReviewResult,
} from "../src/live-review.js";

/**
 * `demo:live` is the command the README tells a new installer to run before
 * putting Gate in CI, so its refusal path matters as much as its happy path: an
 * installer with no engine must be told what to set and where to get one, not
 * dropped into a stack trace.
 *
 * The happy path is not unit-testable without a running engine and a browser, by
 * design; it is exercised by hand against a real `verdict` and the transcript
 * lives in the README.
 */
describe("runLiveReview with no engine configured", () => {
  it("refuses before touching the network, naming what is missing", async () => {
    await expect(runLiveReview({ env: {} })).rejects.toBeInstanceOf(LiveReviewConfigError);
    const error = await runLiveReview({ env: {} }).catch((e: unknown) => e as LiveReviewConfigError);
    expect(error.missing).toEqual(["GATE_ENGINE_ENDPOINT", "GATE_ENGINE_HMAC_SECRET"]);
  });

  it("tells the installer how to get an engine, with runnable commands", async () => {
    const error = await runLiveReview({ env: {} }).catch((e: unknown) => e as LiveReviewConfigError);
    expect(error.message).toContain("GATE_ENGINE_ENDPOINT");
    expect(error.message).toContain("apatureai/verdict");
    expect(error.message).toContain("ENGINE_HMAC_SECRET");
    expect(error.message).toContain("packages/serve/dist/main.js");
  });

  it("names only the setting that is actually missing", async () => {
    const error = await runLiveReview({ env: { GATE_ENGINE_ENDPOINT: "http://127.0.0.1:8791" } }).catch(
      (e: unknown) => e as LiveReviewConfigError,
    );
    expect(error.missing).toEqual(["GATE_ENGINE_HMAC_SECRET"]);
  });
});

/**
 * `demo:live` exists so a wrong shared secret is found on a laptop rather than in
 * CI, and a bare hostname pasted out of a hosting dashboard is the same class of
 * mistake. Before this, it was the one setup error `demo:live` could not help
 * with: it passed the missing-settings check, spent two minutes starting a
 * browser and a fixture server, and then failed with `Failed to parse URL`.
 */
describe("runLiveReview with an endpoint that is not a URL", () => {
  const env = { GATE_ENGINE_ENDPOINT: "verdict-acme.fly.dev", GATE_ENGINE_HMAC_SECRET: "s" };

  it("refuses before starting a browser or a server", async () => {
    await expect(runLiveReview({ env })).rejects.toBeInstanceOf(LiveReviewEndpointError);
  });

  it("shows the value it could not parse and a form that would work", async () => {
    const error = await runLiveReview({ env }).catch((e: unknown) => e as LiveReviewEndpointError);
    expect(error.endpoint.value).toBe("verdict-acme.fly.dev");
    expect(error.message).toContain("GATE_ENGINE_ENDPOINT");
    expect(error.message).toContain("verdict-acme.fly.dev");
    expect(error.message).toContain("https://verdict-acme.fly.dev");
  });

  it("is a different error from the missing-settings one, since the fix differs", async () => {
    const error = await runLiveReview({ env }).catch((e: unknown) => e as Error);
    expect(error).not.toBeInstanceOf(LiveReviewConfigError);
    expect(error.name).toBe("LiveReviewEndpointError");
  });

  it("still leaves a genuinely unset endpoint to the missing-settings error", async () => {
    // Order matters: reporting "not a URL" for an empty string would be the
    // worse first message for a brand-new install.
    const error = await runLiveReview({ env: { GATE_ENGINE_HMAC_SECRET: "s" } }).catch(
      (e: unknown) => e as Error,
    );
    expect(error).toBeInstanceOf(LiveReviewConfigError);
  });
});

describe("the preview it reviews", () => {
  it("is the committed fixture app, resolved absolutely so cwd cannot change it", () => {
    const command = fixturePreviewCommand();
    expect(command.startsWith("node /")).toBe(true);
    expect(command).toContain("fixtures/preview-app.mjs");
    expect(command.endsWith(" serve")).toBe(true);
  });
});

describe("the transcript", () => {
  const base: LiveReviewResult = {
    outDir: "/repo/out",
    endpoint: "http://127.0.0.1:8791",
    previewUrl: "http://127.0.0.1:3311",
    outcome: { status: "not_judged", conclusion: "neutral", commentAction: "created", judgment: "unjudged" },
    checkRun: { name: "Apature Gate", conclusion: "neutral", title: "Not judged", summary: "s" },
    comment: "body",
    commentPath: "/repo/out/live-review-comment.md",
    checkRunPath: "/repo/out/live-check-run.json",
  };

  it("says in words that nothing judged the page", () => {
    const text = formatLiveReviewResult(base, "/repo");
    expect(text).toContain("NOTHING judged the page");
    expect(text).toContain("Gate withheld the grade");
  });

  it("says a model judged it only when the engine attested that", () => {
    const judged = formatLiveReviewResult(
      {
        ...base,
        outcome: { status: "reviewed", conclusion: "neutral", commentAction: "created", judgment: "model_backed" },
        checkRun: { ...base.checkRun, title: "Needs work" },
      },
      "/repo",
    );
    expect(judged).toContain("a model judged the page");
    expect(judged).not.toContain("NOTHING judged");
  });

  it("does not claim a judgment an engine never made", () => {
    const silent = formatLiveReviewResult(
      {
        ...base,
        outcome: { status: "not_judged", conclusion: "neutral", commentAction: "created", judgment: "unattested" },
        checkRun: { ...base.checkRun, title: "Judgment not stated" },
      },
      "/repo",
    );
    expect(silent).toContain("did not state whether a model judged the page");
    expect(silent).toContain("Gate withheld the grade");
    expect(silent).not.toContain("NOTHING judged");
  });

  it("says what the run actually covered, not only whether a model ran (verdict#165)", () => {
    const nothing = formatLiveReviewResult(
      {
        ...base,
        outcome: {
          status: "nothing_reviewed",
          conclusion: "neutral",
          commentAction: "created",
          judgment: "model_backed",
          coverage: "nothing",
        },
        checkRun: { ...base.checkRun, title: "Nothing reviewed" },
      },
      "/repo",
    );
    // The judgment stamp on this run is an honest `model_backed`, so a transcript
    // printing only that line would say "a model judged the page" over zero pages.
    expect(nothing).toContain("a model judged the page");
    expect(nothing).toContain("NOTHING was reviewed");
    expect(nothing).toContain("Gate withheld the grade");
  });

  it("does not report coverage the engine never stated", () => {
    const silent = formatLiveReviewResult(
      {
        ...base,
        outcome: {
          status: "reviewed",
          conclusion: "success",
          commentAction: "created",
          judgment: "model_backed",
        },
      },
      "/repo",
    );
    expect(silent).toContain("coverage        none");
  });

  it("the README's demo:live transcript prints the line this formatter prints", () => {
    const readme = readFileSync(fileURLToPath(new URL("../../../README.md", import.meta.url)), "utf8");
    const rendered = formatLiveReviewResult(
      {
        ...base,
        outcome: {
          status: "not_judged",
          conclusion: "neutral",
          commentAction: "created",
          judgment: "unjudged",
          coverage: "full",
        },
      },
      "/repo",
    );
    const coverageLine = rendered.split("\n").find((line) => line.trimStart().startsWith("coverage "));
    if (!coverageLine) throw new Error("the transcript must carry a coverage line");
    expect(readme).toContain(coverageLine.trim());
  });

  it("blames a failed call on the call, not on the engine's stamp", () => {
    // No `judgment` at all means no result existed. An engine that never
    // answered did not "not state" anything, and saying so read as the engine's
    // fault for a rejected request.
    const failed = formatLiveReviewResult(
      {
        ...base,
        outcome: { status: "engine_rejected", conclusion: "neutral" },
        checkRun: { ...base.checkRun, title: "Review not submitted" },
        comment: null,
      },
      "/repo",
    );
    expect(failed).toContain("no result");
    expect(failed).not.toContain("did not state whether a model judged the page");
  });
});
