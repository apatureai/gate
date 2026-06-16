import { describe, expect, it } from "vitest";
import { loadGoldenReviewResult } from "@gate/types";
import { conclusionForResult, gradeToCheckRunConclusion } from "../src/index.js";

describe("gradeToCheckRunConclusion", () => {
  it("never fails in advisory mode (TRD §7)", () => {
    expect(gradeToCheckRunConclusion("blocked", "advisory")).toBe("neutral");
    expect(gradeToCheckRunConclusion("needs_work", "advisory")).toBe("neutral");
    expect(gradeToCheckRunConclusion("ship_with_nits", "advisory")).toBe("neutral");
    expect(gradeToCheckRunConclusion("ship", "advisory")).toBe("success");
  });

  it("only blocks on explicit opt-in", () => {
    expect(gradeToCheckRunConclusion("blocked", "blocking")).toBe("action_required");
    expect(gradeToCheckRunConclusion("needs_work", "blocking")).toBe("action_required");
    expect(gradeToCheckRunConclusion("ship", "blocking")).toBe("success");
  });

  it("derives a conclusion from the golden engine result", () => {
    const result = loadGoldenReviewResult();
    expect(conclusionForResult(result, "advisory")).toBe("neutral");
    expect(conclusionForResult(result, "blocking")).toBe("action_required");
  });
});
