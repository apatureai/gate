import { describe, expect, it } from "vitest";
import { formatActionError } from "../src/action-error.js";

describe("formatActionError", () => {
  it("names the token when GitHub rejects it, and says the run still exits 0", () => {
    const out = formatActionError(new Error("list comments failed: 401"));
    expect(out).toContain("Apature Gate action error: list comments failed: 401");
    expect(out).toContain("INPUT_GITHUB_TOKEN");
    expect(out).toContain("exits 0");
  });

  it("covers 403 the same way", () => {
    expect(formatActionError(new Error("create check run failed: 403"))).toContain("checks:write");
  });

  it("points 404 at the repository/PR context", () => {
    expect(formatActionError(new Error("get pull request failed: 404"))).toContain("GITHUB_REPOSITORY");
  });

  it("names the two required context variables when they are missing", () => {
    expect(formatActionError(new Error("missing GitHub Action context"))).toContain("GITHUB_EVENT_PATH");
  });

  it("explains EISDIR as a bind mount the Docker daemon could not share", () => {
    const out = formatActionError(new Error("EISDIR: illegal operation on a directory, read"));
    expect(out).toContain("bind mount");
    expect(out).toContain("/tmp");
  });

  it("explains a missing event payload inside the container", () => {
    expect(formatActionError(new Error("ENOENT: no such file or directory, open '/tmp/event.json'"))).toContain(
      "GITHUB_EVENT_PATH does not exist inside the container",
    );
  });

  it("passes an unrecognised error through with no invented hint", () => {
    expect(formatActionError(new Error("boom"))).toBe("Apature Gate action error: boom");
    expect(formatActionError("not an error")).toBe("Apature Gate action error: not an error");
  });

  it("does not mistake a status inside a longer sentence for a token problem", () => {
    expect(formatActionError(new Error("engine submit failed: 401 while polling job 7"))).toBe(
      "Apature Gate action error: engine submit failed: 401 while polling job 7",
    );
  });
});
