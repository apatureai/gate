import { loadGoldenReviewResult, type GateReviewResult, type JudgmentProvenance } from "@gate/types";
import { describe, expect, it } from "vitest";
import {
  buildCheckRun,
  decideDelivery,
  judgmentState,
  NO_MODEL_DISCLOSURE_PREFIX,
  renderStickyComment,
} from "../src/index.js";

/**
 * The unjudged case, end to end through delivery.
 *
 * verdict answers a run with no model configured by capturing and measuring the
 * page for real and filling the critique from a deterministic stand-in. That
 * result is shaped exactly like a clean review: `grade: "ship"`, `findings: []`.
 * What separates them is the `provenance` stamp and the disclosure line, and if
 * delivery ignores both, a page nothing looked at gets a green ✅ Ship.
 *
 * These are the assertions that make that impossible.
 */
const golden = loadGoldenReviewResult();

const UNJUDGED: JudgmentProvenance = {
  model_backed: false,
  source: "canned",
  engine: "verdict-http",
  model: null,
  detail:
    "verdict ran this review with the mock client: the capture, the DOM geometry map and the " +
    "measured contrast, overflow and touch-target facts are real, but the grade, the narrative " +
    "and any findings came from a deterministic stand-in rather than from a model",
};

const DISCLOSURE = `${NO_MODEL_DISCLOSURE_PREFIX}: ${UNJUDGED.detail}.`;

/** The wire result verdict actually returns with `--model mock`, verbatim in shape. */
function unjudgedResult(overrides: Partial<GateReviewResult> = {}): GateReviewResult {
  return {
    ...golden,
    grade: "ship",
    overall: DISCLOSURE,
    findings: [],
    notReviewed: [DISCLOSURE],
    provenance: UNJUDGED,
    ...overrides,
  };
}

const judged = (): GateReviewResult => ({
  ...golden,
  provenance: { model_backed: true, source: "model", engine: "verdict-http", model: "qwen3-vl-plus", detail: "a model judged it" },
});

describe("judgmentState", () => {
  it("reads the engine's structural stamp", () => {
    expect(judgmentState(unjudgedResult())).toBe("unjudged");
    expect(judgmentState(judged())).toBe("model_backed");
  });

  it("treats an explicit `cannot tell` as unconfirmed, not as judged", () => {
    const result = { ...golden, provenance: { ...UNJUDGED, model_backed: null, source: "unknown" as const } };
    expect(judgmentState(result)).toBe("unconfirmed");
  });

  it("falls back to the prose disclosure when only that arrived", () => {
    const result = { ...golden, notReviewed: [DISCLOSURE], provenance: undefined };
    expect(judgmentState(result)).toBe("unjudged");
  });

  it("never lets a `model_backed: true` claim override its own disclosure line", () => {
    const contradictory = {
      ...golden,
      notReviewed: [DISCLOSURE],
      provenance: { ...UNJUDGED, model_backed: true },
    };
    expect(judgmentState(contradictory)).toBe("unjudged");
  });

  it("calls a result with no stamp at all unattested, not unjudged", () => {
    // The pre-provenance wire shape. Gate's schema contract is additive-only, so
    // silence cannot be read as a confession without neutralizing every
    // conforming engine that has not adopted the field.
    expect(golden.provenance).toBeUndefined();
    expect(judgmentState(golden)).toBe("unattested");
  });
});

describe("Check Run for an unjudged result", () => {
  it("is neutral even though the engine graded it `ship`", () => {
    const result = unjudgedResult();
    expect(result.grade).toBe("ship");
    const run = buildCheckRun(result, "none");
    expect(run.conclusion).toBe("neutral");
    expect(run.title).toBe("Not judged");
  });

  it("never says Ship, and says there is no grade", () => {
    const run = buildCheckRun(unjudgedResult(), "none");
    expect(run.title).not.toContain("Ship");
    expect(run.summary).not.toContain("**Grade:**");
    expect(run.summary).toContain("No grade.");
    expect(run.summary).toContain("nothing judged it");
  });

  it("carries the engine's own explanation of why", () => {
    expect(buildCheckRun(unjudgedResult(), "none").summary).toContain("deterministic stand-in");
  });

  it("stays neutral under gate: blockers too — an unjudged run is not a PR failure", () => {
    const run = buildCheckRun(unjudgedResult({ grade: "blocked" }), "blockers");
    expect(run.conclusion).toBe("neutral");
  });

  it("still grades a result the engine attests a model produced", () => {
    const run = buildCheckRun({ ...judged(), grade: "ship" }, "none");
    expect(run.conclusion).toBe("success");
    expect(run.title).toBe("Ship");
  });
});

describe("sticky comment for an unjudged result", () => {
  const body = renderStickyComment(unjudgedResult(), { headSha: "0".repeat(40) });

  it("leads with the disclosure, not a grade badge", () => {
    expect(body).not.toContain("✅ Ship");
    expect(body).toContain("no design review");
    expect(body).toContain("Not judged");
  });

  it("says the capture is real and the verdict is not", () => {
    expect(body).toContain("captured and measured for real");
    expect(body).toContain("withholding");
  });

  it("does not print the engine's stand-in narrative as a summary", () => {
    // `overall` on this path is the disclosure itself; what must not happen is a
    // stand-in's prose about a page it never saw being rendered as a verdict.
    const withNarrative = unjudgedResult({ overall: "Clean, well-balanced pricing page." });
    expect(renderStickyComment(withNarrative, { headSha: "0".repeat(40) })).not.toContain(
      "Clean, well-balanced pricing page.",
    );
  });

  it("withholds unjudged findings and says how many it withheld", () => {
    const withFindings = unjudgedResult({ findings: golden.findings });
    expect(golden.findings.length).toBeGreaterThan(0);
    const rendered = renderStickyComment(withFindings, { headSha: "0".repeat(40) });
    for (const finding of golden.findings) expect(rendered).not.toContain(finding.title);
    expect(rendered).toContain(`${golden.findings.length} unjudged finding(s)`);
  });

  it("does not attribute the run to the model the engine is configured to route to", () => {
    expect(body).toContain("not called; nothing judged this page");
  });

  it("renders a judged result exactly as before", () => {
    const rendered = renderStickyComment(judged(), { headSha: "0".repeat(40) });
    expect(rendered).toContain("## Apature Gate — design review");
    expect(rendered).toContain(golden.overall);
    expect(rendered).toContain(`model ${golden.metadata.model}`);
  });
});

describe("decideDelivery on an unjudged completed outcome", () => {
  const decision = decideDelivery(
    { status: "completed", result: unjudgedResult(), jobId: "job_1" },
    { headSha: "0".repeat(40), gate: "blockers" },
  );

  it("still publishes: the capture and the measurements are real and useful", () => {
    expect(decision.publishComment).toBe(true);
    expect(decision.comment).toBeTruthy();
  });

  it("reports the judgment state so the run record cannot call it a review", () => {
    expect(decision.judgment).toBe("unjudged");
  });

  it("publishes it as neutral", () => {
    expect(decision.checkRun.conclusion).toBe("neutral");
  });
});

describe("an unattested result keeps its grade but says so", () => {
  it("publishes the grade with a visible caveat", () => {
    const run = buildCheckRun(golden, "none");
    expect(run.summary).toContain("**Grade:**");
    expect(run.summary).toContain("did not state whether a model judged this page");
    const body = renderStickyComment(golden, { headSha: "0".repeat(40) });
    expect(body).toContain("did not state whether a model judged this page");
  });
});
