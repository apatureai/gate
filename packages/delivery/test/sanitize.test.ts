import { describe, expect, it } from "vitest";
import {
  escapeTableCell,
  safeLinkUrl,
  sanitizeCodeSpan,
  sanitizeDisplayText,
} from "../src/sanitize.js";

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

  it("cannot close an HTML block it was rendered inside", () => {
    const out = sanitizeDisplayText("done </details> now");
    expect(out).not.toContain("</details>");
    expect(out).toContain("\\</details\\>");
  });

  it("cannot forge a bold verdict line", () => {
    const out = sanitizeDisplayText("**✅ Ship** · reviewed and approved");
    expect(out).not.toContain("**");
    expect(out).toContain("\\*\\*✅ Ship\\*\\*");
  });

  it("cannot start a list item or a heading of its own", () => {
    expect(sanitizeDisplayText("- forged bullet")).toBe("\\- forged bullet");
    expect(sanitizeDisplayText("1. forged item")).toBe("1\\. forged item");
    expect(sanitizeDisplayText("# forged heading")).toBe("\\# forged heading");
  });

  it("leaves ordinary prose punctuation alone: a version and a hyphen are not markers", () => {
    // A list marker needs the space after it; `2026.06.0` and `off-brand` do not
    // have one, and escaping them would be noise for no safety.
    expect(sanitizeDisplayText("2026.06.0")).toBe("2026.06.0");
    expect(sanitizeDisplayText("off-brand color")).toBe("off-brand color");
  });

  it("cannot break out of a table cell", () => {
    const out = sanitizeDisplayText("a | b");
    expect(out).toBe("a \\| b");
  });
});

describe("sanitizeCodeSpan", () => {
  it("returns a closed span around a value the operator can still read", () => {
    expect(sanitizeCodeSpan("/pricing")).toBe("`/pricing`");
    // No escaping inside: a backslash is literal in a code span, so escaping
    // there would show the operator a value they never configured.
    expect(sanitizeCodeSpan("signature_mismatch")).toBe("`signature_mismatch`");
    expect(sanitizeCodeSpan("https://verdict.example")).toBe("`https://verdict.example`");
  });

  it("cannot close the span early: the only character that could is neutralized", () => {
    const out = sanitizeCodeSpan("a` </details> ## forged");
    expect(out).toBe("`a' </details> ## forged`");
    expect(out.match(/`/g)).toHaveLength(2);
  });

  it("collapses newlines and strips control characters", () => {
    expect(sanitizeCodeSpan("a\n\n# b")).toBe("`a # b`");
    expect(sanitizeCodeSpan(`a${String.fromCharCode(8)}b`)).toBe("`a b`");
  });

  it("caps the length and never emits an empty (unclosed) span", () => {
    const out = sanitizeCodeSpan("x".repeat(500), 80);
    expect(out.length).toBe(82);
    expect(out.endsWith(`${ELLIPSIS}\``)).toBe(true);
    expect(sanitizeCodeSpan("   ")).toBe("`(empty)`");
  });
});

describe("safeLinkUrl", () => {
  it("passes an absolute http(s) URL through unmangled", () => {
    expect(safeLinkUrl("https://artifacts.example/shot_001.png")).toBe(
      "https://artifacts.example/shot_001.png",
    );
    expect(safeLinkUrl("http://localhost:3000/a?b=c#d")).toBe("http://localhost:3000/a?b=c#d");
  });

  it("refuses every scheme that is not http(s)", () => {
    expect(safeLinkUrl("javascript:alert(1)")).toBeNull();
    expect(safeLinkUrl("data:text/html;base64,PHNjcmlwdD4=")).toBeNull();
    expect(safeLinkUrl("vbscript:msgbox(1)")).toBeNull();
    expect(safeLinkUrl("file:///etc/passwd")).toBeNull();
  });

  it("refuses a relative reference, which has no scheme to check", () => {
    expect(safeLinkUrl("./annotated-f_001.png")).toBeNull();
    expect(safeLinkUrl("/pwn")).toBeNull();
    expect(safeLinkUrl("")).toBeNull();
  });

  it("percent-encodes the parentheses that would end the destination early", () => {
    // The brackets survive, and are inert: a destination ends at its matching
    // parenthesis, and both of those are encoded.
    expect(safeLinkUrl("https://x.example/a) [Ship](https://evil.example")).toBe(
      "https://x.example/a%29%20[Ship]%28https://evil.example",
    );
  });

  it("refuses an unbounded URL", () => {
    expect(safeLinkUrl(`https://x.example/${"a".repeat(4000)}`)).toBeNull();
  });
});

describe("escapeTableCell", () => {
  it("escapes the pipe GFM would otherwise treat as a cell boundary", () => {
    expect(escapeTableCell("`/a|b`")).toBe("`/a\\|b`");
  });
});
