import { describe, expect, it } from "vitest";
import { sanitizeDisplayText } from "../src/sanitize.js";

const ZWSP = String.fromCharCode(0x200b);
const ELLIPSIS = String.fromCharCode(0x2026);

describe("sanitizeDisplayText (gate #156)", () => {
  it("passes clean aggregate prose through, readable", () => {
    const out = sanitizeDisplayText("1 console error and 2 failed requests during capture.");
    expect(out).toContain("console error");
    expect(out).toContain("failed requests");
  });

  it("cannot inject a link", () => {
    const out = sanitizeDisplayText("see [click me](https://evil.example/steal)");
    expect(out).not.toContain("](");
    expect(out).toContain(`https${ZWSP}://`); // defanged, no live autolink
  });

  it("cannot inject an HTML block: every angle bracket is escaped", () => {
    const out = sanitizeDisplayText("<img src=x onerror=alert(1)> <script>bad()</script>");
    // GFM renders `\<` as a literal `<`, so no tag is ever emitted: there is no
    // UNESCAPED `<` or `>` in the output.
    expect(out).not.toMatch(/(?<!\\)[<>]/);
    expect(out).toContain("\\<img"); // present only as escaped, inert text
  });

  it("cannot inject a mention", () => {
    const out = sanitizeDisplayText("cc @octocat");
    expect(out).toContain(`@${ZWSP}`); // @ neutralized with a zero-width space
    expect(out).not.toContain("@octocat");
  });

  it("collapses newlines so no block construct (heading/table) can be injected", () => {
    const out = sanitizeDisplayText("line1\n# Heading\n| a | b |");
    expect(out).not.toContain("\n");
    expect(out.startsWith("#")).toBe(false);
  });

  it("strips control characters and caps unbounded length", () => {
    expect(sanitizeDisplayText(`a${String.fromCharCode(8)}b`)).toBe("ab");
    const out = sanitizeDisplayText("x".repeat(2000), 500);
    expect(out.length).toBeLessThanOrEqual(500);
    expect(out.endsWith(ELLIPSIS)).toBe(true);
  });
});
