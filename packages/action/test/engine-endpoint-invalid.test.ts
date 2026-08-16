import { engineEndpointInvalidCheckRun } from "@gate/delivery";
import { classifyEngineFailure, createHttpEngineTransport } from "@gate/engine";
import { malformedEngineEndpoint, resolveEngineClientEnv } from "@gate/secrets";
import { decideDeliveryForError } from "@gate/delivery";
import { describe, expect, it } from "vitest";

/**
 * A set-but-unusable endpoint used to be reported as a transient outage, forever.
 *
 * `missingEngineSettings` only asked whether the value was blank, so
 * `verdict-acme.fly.dev` (the exact string the Fly, Render and Railway dashboards
 * print) passed setup, died at the first fetch with
 * `TypeError: Failed to parse URL from verdict-acme.fly.dev/jobs`, reached
 * `classifyEngineFailure` with no HTTP status, and fell to its default branch:
 * "The design engine is temporarily unavailable. The PR is not blocked; Gate will
 * retry." Every push, forever, for a condition no amount of waiting clears.
 */
describe("malformedEngineEndpoint", () => {
  const env = (endpoint: string, rest: Record<string, string> = {}) =>
    resolveEngineClientEnv({
      GATE_ENGINE_ENDPOINT: endpoint,
      GATE_ENGINE_HMAC_SECRET: "s",
      ...rest,
    });

  it("rejects the bare hostname a hosting dashboard hands you", () => {
    const problem = malformedEngineEndpoint(env("verdict-acme.fly.dev"));
    expect(problem).not.toBeNull();
    expect(problem?.variableName).toBe("GATE_ENGINE_ENDPOINT");
    expect(problem?.value).toBe("verdict-acme.fly.dev");
    expect(problem?.reason).toContain("no scheme");
    expect(problem?.suggestion).toBe("https://verdict-acme.fly.dev");
  });

  it("rejects a typo'd scheme, which parses as a URL but is not one fetch can use", () => {
    const problem = malformedEngineEndpoint(env("htp://verdict-acme.fly.dev"));
    expect(problem?.reason).toContain("`htp:`");
    expect(problem?.suggestion).toBe("https://verdict-acme.fly.dev");
  });

  it("rejects a host:port, whose first colon URL parsing reads as a scheme", () => {
    // `new URL("verdict-acme.fly.dev:8080")` succeeds with protocol
    // `verdict-acme.fly.dev:`, so the parse alone does not catch this one and the
    // scheme check is not optional. The port has to survive into the suggestion,
    // and the operator is told what they did (left the scheme off) rather than
    // that their scheme is `verdict-acme.fly.dev:`, which is true and useless.
    const problem = malformedEngineEndpoint(env("verdict-acme.fly.dev:8080"));
    expect(problem?.reason).toBe("it has no scheme, so it is not a URL");
    expect(problem?.reason).not.toContain("verdict-acme.fly.dev:`");
    expect(problem?.suggestion).toBe("https://verdict-acme.fly.dev:8080");
  });

  it("rejects a scheme-relative value", () => {
    const problem = malformedEngineEndpoint(env("//verdict-acme.fly.dev"));
    expect(problem?.suggestion).toBe("https://verdict-acme.fly.dev");
  });

  it("offers no suggestion rather than a wrong one", () => {
    // Rewriting this would print `https://etc/hosts`, which looks like an answer
    // and is not one, so the check run says what is wrong and stops there.
    const problem = malformedEngineEndpoint(env("file:///etc/hosts"));
    expect(problem?.reason).toContain("`file:`");
    expect(problem?.suggestion).toBeNull();
  });

  it("accepts a special-scheme URL that parsing normalizes to a real host", () => {
    // `https:///jobs` becomes `https://jobs/`: a host that will not resolve, but
    // one Gate can genuinely send to, so the answer belongs to the network and
    // not to this check. Guessing here would reject a legal URL.
    expect(malformedEngineEndpoint(env("https:///jobs"))).toBeNull();
  });

  it("accepts the endpoints that actually work, http and https, port and path", () => {
    for (const endpoint of [
      "http://127.0.0.1:8791",
      "https://verdict-acme.fly.dev",
      "https://verdict-acme.fly.dev/",
      "https://acme.example/engine",
      "  https://acme.example  ",
    ]) {
      expect(malformedEngineEndpoint(env(endpoint))).toBeNull();
    }
  });

  it("leaves a blank endpoint to missingEngineSettings, which owns that answer", () => {
    // Reporting both would tell a brand-new install that its unset endpoint is
    // badly formatted, which is a worse first message than "set this variable".
    expect(malformedEngineEndpoint(resolveEngineClientEnv({}))).toBeNull();
    expect(malformedEngineEndpoint(env("   "))).toBeNull();
  });

  it("names the deprecated variable when that is the one actually set", () => {
    const legacy = resolveEngineClientEnv({
      JUDGMENT_ENGINE_ENDPOINT: "verdict-acme.fly.dev",
      GATE_ENGINE_HMAC_SECRET: "s",
    });
    expect(malformedEngineEndpoint(legacy)?.variableName).toBe("JUDGMENT_ENGINE_ENDPOINT");
  });
});

describe("the Check Run a malformed endpoint gets", () => {
  // Built from explicit facts rather than from `malformedEngineEndpoint(...)!`,
  // so that a detector regression fails the detector's own tests one by one
  // instead of throwing at import and collecting this whole file as "0 test".
  const run = engineEndpointInvalidCheckRun({
    variableName: "GATE_ENGINE_ENDPOINT",
    value: "verdict-acme.fly.dev",
    reason: "it has no scheme, so it is not a URL",
    suggestion: "https://verdict-acme.fly.dev",
  });

  it("is fed exactly what the detector produces, so the two cannot drift", () => {
    expect(
      malformedEngineEndpoint(
        resolveEngineClientEnv({
          GATE_ENGINE_ENDPOINT: "verdict-acme.fly.dev",
          GATE_ENGINE_HMAC_SECRET: "s",
        }),
      ),
    ).toEqual({
      variableName: "GATE_ENGINE_ENDPOINT",
      value: "verdict-acme.fly.dev",
      reason: "it has no scheme, so it is not a URL",
      suggestion: "https://verdict-acme.fly.dev",
    });
  });

  it("is neutral, and never reads as a pass", () => {
    expect(run.conclusion).toBe("neutral");
    expect(run.title).toBe("Engine endpoint invalid");
    expect(run.summary).toContain("This is not a pass.");
  });

  it("names the variable and shows the value it could not parse", () => {
    expect(run.summary).toContain("`GATE_ENGINE_ENDPOINT`");
    expect(run.summary).toContain("`verdict-acme.fly.dev`");
  });

  it("says what a correct one looks like", () => {
    expect(run.summary).toContain("`https://verdict-acme.fly.dev`");
    expect(run.summary).toContain("absolute http or https URL");
  });

  it("does not promise a retry, because this one never clears on its own", () => {
    expect(run.summary).toContain("does not clear by itself");
    expect(run.summary).not.toMatch(/temporarily unavailable/);
    expect(run.summary).not.toMatch(/Gate will retry/);
  });

  it("cannot be broken out of its code span by the configured value", () => {
    const nasty = engineEndpointInvalidCheckRun({
      variableName: "GATE_ENGINE_ENDPOINT",
      value: "`\n## injected heading\n[link](https://evil.example)",
      reason: "it has no scheme, so it is not a URL",
      suggestion: null,
    });
    expect(nasty.summary).not.toContain("\n## injected heading");
    expect(nasty.summary.split("\n").some((line) => line.startsWith("##"))).toBe(false);
  });
});

describe("what the operator saw before this check existed", () => {
  it("is the default branch of classifyEngineFailure, and it is wrong", async () => {
    const transport = createHttpEngineTransport({
      baseUrl: "verdict-acme.fly.dev",
      hmacSecret: "s",
    });
    const submission = {
      idempotencyKey: "k",
      depth: "deep",
      request: {
        installationId: "acme/web",
        repository: { owner: "acme", name: "web", defaultBranch: "main" },
        pullRequest: {
          number: 7,
          headSha: "0".repeat(40),
          baseSha: "f".repeat(40),
          title: "t",
          body: null,
        },
        preview: { url: "https://acme.example", provider: "explicit", environment: "preview" },
        config: {},
        publishMode: "publish",
      },
    };

    const err = await transport
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- exercising the raw transport with a minimal submission
      .submit(submission as any)
      .then(() => null)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("Failed to parse URL");

    const failure = classifyEngineFailure(err);
    expect(failure.kind).toBe("engine_unavailable");
    expect(failure.status).toBeNull();
    const delivery = decideDeliveryForError(failure.kind, {
      code: failure.code,
      status: failure.status,
    });
    // The exact sentence the blocker is about. It is still correct for a real
    // outage, which is why the fix is upstream of it rather than in here.
    expect(delivery.checkRun.summary).toContain("temporarily unavailable");
    expect(delivery.checkRun.summary).toContain("Gate will retry");

    // And this is the one that now runs first.
    expect(
      malformedEngineEndpoint(
        resolveEngineClientEnv({
          GATE_ENGINE_ENDPOINT: "verdict-acme.fly.dev",
          GATE_ENGINE_HMAC_SECRET: "s",
        }),
      ),
    ).not.toBeNull();
  });
});
