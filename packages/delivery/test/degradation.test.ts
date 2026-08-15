import type { PollOutcome } from "@gate/engine";
import { loadGoldenReviewResult } from "@gate/types";
import { describe, expect, it } from "vitest";
import {
  decideDelivery,
  decideDeliveryForError,
  validateFindings,
  type DegradationContext,
} from "../src/index.js";

const golden = loadGoldenReviewResult();
const ctx: DegradationContext = { headSha: "abc1234", gate: "none", runUrl: "https://gate.app/r/1" };

describe("validateFindings", () => {
  it("keeps page-level (null element) findings and drops empty refs", () => {
    const out = validateFindings([
      { ...golden.findings[0]!, element: null },
      { ...golden.findings[0]!, element: "   " },
      { ...golden.findings[0]!, element: ".valid" },
    ]);
    expect(out.valid).toHaveLength(2);
    expect(out.dropped).toBe(1);
  });

  it("applies an injected element validator", () => {
    const out = validateFindings([{ ...golden.findings[0]!, element: ".gone" }], (s) => s !== ".gone");
    expect(out.dropped).toBe(1);
  });
});

describe("decideDelivery", () => {
  it("timeout -> neutral, no comment, PR never failed", () => {
    const outcome: PollOutcome = { status: "timed_out", reason: "review_timed_out", jobId: "j" };
    const d = decideDelivery(outcome, ctx);
    expect(d.publishComment).toBe(false);
    expect(d.reason).toBe("review_timed_out");
    expect(d.checkRun.conclusion).toBe("neutral");
    expect(d.checkRun.summary).toMatch(/not blocked/);
  });

  it("engine failure -> neutral, no comment", () => {
    const d = decideDelivery({ status: "failed", error: "boom", jobId: "j" }, ctx);
    expect(d).toMatchObject({ publishComment: false, reason: "engine_failed" });
    expect(d.checkRun.conclusion).toBe("neutral");
  });

  it("completed -> publishes validated findings with check run + comment", () => {
    const d = decideDelivery({ status: "completed", result: golden, jobId: "j" }, ctx);
    expect(d.publishComment).toBe(true);
    expect(d.comment).toContain("Apature Gate");
    expect(d.checkRun.conclusion).toBe("neutral"); // needs_work + gate none
  });

  it("drops invalid-element findings and adds a caveat", () => {
    const result = {
      ...golden,
      findings: [{ ...golden.findings[0]!, element: "" }, { ...golden.findings[1]! }],
    };
    const d = decideDelivery({ status: "completed", result, jobId: "j" }, ctx);
    expect(d.caveat).toMatch(/couldn't be validated/);
    expect(d.comment).toContain("couldn't be validated");
  });

  it("surfaces a capture-instability caveat", () => {
    const d = decideDelivery({ status: "completed", result: golden, jobId: "j" }, { ...ctx, captureUnstable: true });
    expect(d.caveat).toMatch(/unstable/);
  });

  it("only blocks on blocked grade when gate:blockers", () => {
    const blockedResult = { ...golden, grade: "blocked" as const };
    expect(decideDelivery({ status: "completed", result: blockedResult, jobId: "j" }, ctx).checkRun.conclusion).toBe(
      "neutral",
    );
    expect(
      decideDelivery({ status: "completed", result: blockedResult, jobId: "j" }, { ...ctx, gate: "blockers" }).checkRun
        .conclusion,
    ).toBe("failure");
  });
});

describe("decideDeliveryForError", () => {
  it("maps unavailable + circuit-open to a neutral retry Check Run", () => {
    expect(decideDeliveryForError("engine_unavailable").checkRun.conclusion).toBe("neutral");
    const cb = decideDeliveryForError("circuit_open");
    expect(cb.checkRun.conclusion).toBe("neutral");
    expect(cb.reason).toBe("circuit_open");
  });
});

describe("a permanent setup mistake never promises a retry", () => {
  it("names the version mismatch instead of calling it an outage", () => {
    const decision = decideDeliveryForError("engine_rejected", {
      code: "schema_version_mismatch",
      status: null,
    });
    expect(decision.checkRun.conclusion).toBe("neutral");
    expect(decision.checkRun.summary).toContain("incompatible majors");
    expect(decision.checkRun.summary).not.toContain("temporarily unavailable");
    expect(decision.checkRun.summary).not.toContain("will retry");
  });

  it("tells an operator whose endpoint answers 200 that it is the wrong URL", () => {
    const decision = decideDeliveryForError("engine_rejected", { code: null, status: 200 });
    expect(decision.checkRun.summary).toContain("GATE_ENGINE_ENDPOINT");
    expect(decision.checkRun.summary).toContain("not the critique service's base URL");
    expect(decision.checkRun.summary).not.toContain("temporarily unavailable");
  });
});
