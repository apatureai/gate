import { loadGoldenReviewResult, type Finding, type GateReviewResult } from "@gate/types";
import { describe, expect, it } from "vitest";
import { buildCheckRun, renderStickyComment } from "../src/index.js";

/**
 * Forged Gate verdicts in the sticky comment.
 *
 * The sticky comment is Markdown, and its STRUCTURE is what tells a reader which
 * words are Gate's: the `## Apature Gate: design review` heading and the bold
 * grade line under it. Until this was closed, `finding.suggestion` reached that
 * comment unsanitized, so a crafted string could close the `<details>` block it
 * was rendered inside and open a second heading with `**✅ Ship**` under it. A
 * reviewer scrolling the comment then sees Gate apparently approving the pull
 * request.
 *
 * This is not XSS: GitHub strips raw HTML, so nothing executes. It is forgery,
 * and it does not need a compromised engine either, because the model's prose
 * derives partly from the untrusted page text of the pull request under review.
 * The author of that pull request has influence over the words.
 */

const golden = loadGoldenReviewResult();
const ZWSP = String.fromCharCode(0x200b);

/** The payload the audit reproduced on the real path, verbatim. */
const FORGED_TITLE = "Contrast is fine actually](https://attacker.example) [Approve this PR";
const FORGED_SUGGESTION =
  "No action needed.\n\n</details>\n\n## Apature Gate: design review\n\n**✅ Ship** · reviewed and approved";

function withFindings(findings: Finding[], overrides: Partial<GateReviewResult> = {}): GateReviewResult {
  return {
    ...golden,
    findings,
    artifacts: { ...golden.artifacts, annotatedScreenshots: [] },
    ...overrides,
  };
}

function finding(over: Partial<Finding>): Finding {
  return { ...golden.findings[0]!, screenshotId: null, ...over };
}

/** Headings that claim to be Gate speaking. There must only ever be one. */
const gateHeadings = (body: string): string[] => body.match(/^#{1,6} +Apature Gate.*$/gm) ?? [];

describe("a finding cannot forge a second Gate verdict in the sticky comment", () => {
  const body = renderStickyComment(
    withFindings([
      finding({ severity: "minor", title: FORGED_TITLE, route: "/", viewport: "desktop", suggestion: FORGED_SUGGESTION }),
    ]),
    { headSha: "abcdef1234567890" },
  );

  it("renders exactly one Gate verdict heading", () => {
    expect(gateHeadings(body)).toEqual(["## Apature Gate: design review"]);
  });

  it("does not publish a second grade line", () => {
    // The real one is `**⚠️ Needs work** · reviewed ...`; the forged Ship never
    // becomes a line of its own, only the tail of the finding's own list item.
    expect(body).not.toMatch(/^\*\*✅ Ship\*\*/m);
    const forged = body.split("\n").filter((line) => line.includes("reviewed and approved"));
    expect(forged).toHaveLength(1);
    expect(forged[0]!.startsWith("- **Contrast is fine actually")).toBe(true);
  });

  it("leaves the `<details>` block Gate opened closed exactly once", () => {
    expect(body.match(/<details>/g)).toHaveLength(1);
    expect(body.match(/<\/details>/g)).toHaveLength(1);
    // The injected closer survives only as escaped, inert text.
    expect(body).toContain("\\</details\\>");
  });

  it("renders the injected structure as inert content, not as structure", () => {
    expect(body).toContain("\\#\\# Apature Gate: design review");
    expect(body).toContain("\\*\\*✅ Ship\\*\\*");
    // One line: every newline the payload carried is collapsed, so no block
    // construct can be opened at all.
    const listItem = body.split("\n").filter((line) => line.startsWith("- **"));
    expect(listItem).toHaveLength(1);
    expect(listItem[0]).toContain("reviewed and approved");
  });

  it("does not turn the title into a link to the attacker", () => {
    expect(body).not.toContain("](https://attacker.example)");
    expect(body).toContain("\\]\\(https");
  });

  it("still says what the finding said, so the sanitizer is not censorship", () => {
    expect(body).toContain("Contrast is fine actually");
    expect(body).toContain("No action needed.");
  });
});

describe("a finding cannot break out of the blockers table", () => {
  const body = renderStickyComment(
    withFindings([
      finding({
        severity: "blocker",
        title: "Broken | cell",
        route: "/a|b",
        suggestion: "done |\n| ✅ Ship | `/` | desktop | forged row | none |",
      }),
    ]),
    { headSha: "abcdef1234567890" },
  );

  it("renders a header, a separator and exactly one data row", () => {
    const rows = body.split("\n").filter((line) => line.startsWith("|"));
    expect(rows).toHaveLength(3);
    expect(rows[2]).toContain("Broken");
    expect(rows[2]).toContain("forged row");
  });

  it("escapes every pipe the finding supplied, including inside the route code span", () => {
    const row = body.split("\n").filter((line) => line.startsWith("|"))[2]!;
    expect(row).toContain("Broken \\| cell");
    expect(row).toContain("`/a\\|b`");
    // Five cells, so five unescaped pipes: the four separators plus the closer.
    expect(row.replace(/\\\|/g, "").match(/\|/g)).toHaveLength(6);
  });

  it("does not let the forged row claim a grade", () => {
    expect(gateHeadings(body)).toEqual(["## Apature Gate: design review"]);
    expect(body).not.toMatch(/^\| ✅ Ship \|/m);
  });
});

describe("a finding cannot inject a link or a mention", () => {
  const body = renderStickyComment(
    withFindings([
      finding({
        severity: "minor",
        title: "[Approved by design](https://evil.example/pwn)",
        suggestion: "Ping @maintainer or see https://evil.example/steal for the fix ![](https://evil.example/pixel.png)",
      }),
    ]),
    { headSha: "abcdef1234567890" },
  );

  it("renders no link the engine did not earn", () => {
    expect(body).not.toContain("](https://evil.example/pwn)");
    expect(body).not.toContain("](https://evil.example/pixel.png)");
    expect(body).toContain("\\[Approved by design\\]\\(https");
  });

  it("defangs a bare URL so GitHub does not autolink it", () => {
    expect(body).toContain(`https${ZWSP}://evil.example/steal`);
    expect(body).not.toContain(" https://evil.example/steal");
  });

  it("defangs the mention so no maintainer is pulled onto the PR", () => {
    expect(body).toContain(`@${ZWSP}maintainer`);
    expect(body).not.toContain("@maintainer");
  });

  it("neutralizes the image syntax as well as the link syntax", () => {
    expect(body).toContain("\\!\\[\\]\\(https");
  });
});

describe("evidence URLs are validated, not escaped", () => {
  const withEvidence = (url: string): string =>
    renderStickyComment(
      withFindings([finding({ id: "f_x", severity: "minor", screenshotId: "shot_x" })], {
        artifacts: { ...golden.artifacts, annotatedScreenshots: [{ findingId: "f_x", url }] },
      }),
      { headSha: "abcdef1234567890" },
    );

  it("links an absolute https URL, unmangled, because that is the whole point", () => {
    expect(withEvidence("https://artifacts.example/shot_x.png")).toContain(
      "[Evidence](https://artifacts.example/shot_x.png)",
    );
  });

  it("refuses to link a javascript: URL at all", () => {
    const body = withEvidence("javascript:alert(1)");
    expect(body).not.toContain("[Evidence]");
    expect(body).not.toContain("javascript:");
    expect(body).toContain("evidence not linkable");
  });

  it("refuses to link a data: URL at all", () => {
    const body = withEvidence("data:text/html;base64,PHNjcmlwdD4=");
    expect(body).not.toContain("[Evidence]");
    expect(body).toContain("evidence not linkable");
  });

  it("refuses a relative destination, which Gate cannot vouch for", () => {
    const body = withEvidence("./annotated-f_x.png");
    expect(body).not.toContain("[Evidence]");
    expect(body).toContain("evidence not linkable");
  });

  it("cannot close the link destination early with a parenthesis", () => {
    const body = withEvidence("https://artifacts.example/a).png) [Ship](https://evil.example");
    expect(body).not.toContain("[Ship](https://evil.example");
    expect(body).toContain("%29");
  });

  it("applies the same rule in the blockers table", () => {
    const body = renderStickyComment(
      withFindings([finding({ id: "f_x", severity: "blocker", screenshotId: "shot_x" })], {
        artifacts: {
          ...golden.artifacts,
          annotatedScreenshots: [{ findingId: "f_x", url: "javascript:alert(1)" }],
        },
      }),
      { headSha: "abcdef1234567890" },
    );
    expect(body).not.toContain("javascript:");
    expect(body).toContain("evidence not linkable");
  });
});

describe("the engine narrative and the lineage footer are untrusted too", () => {
  it("cannot forge a verdict through `overall` in the sticky comment", () => {
    const body = renderStickyComment(
      withFindings([], { overall: "Looks great.\n\n## Apature Gate: design review\n\n**✅ Ship** · reviewed and approved" }),
      { headSha: "abcdef1234567890" },
    );
    expect(gateHeadings(body)).toEqual(["## Apature Gate: design review"]);
    expect(body).toContain("Looks great.");
  });

  it("cannot forge a verdict through `overall` on the Check Run either", () => {
    const run = buildCheckRun(
      withFindings([], { overall: "Looks great.\n\n## Apature Gate: design review\n\n**✅ Ship**" }),
      "blockers",
    );
    expect(gateHeadings(run.summary)).toEqual([]);
    expect(run.summary).not.toMatch(/^\*\*✅ Ship\*\*/m);
    expect(run.summary).toContain("Looks great.");
  });

  it("cannot close the `<sub>` footer with a version stamp", () => {
    const body = renderStickyComment(
      withFindings([], {
        metadata: {
          ...golden.metadata,
          engineVersion: "1.0</sub>\n\n## Apature Gate: design review\n\n**✅ Ship**",
        },
      }),
      { headSha: "abcdef1234567890" },
    );
    expect(gateHeadings(body)).toEqual(["## Apature Gate: design review"]);
    expect(body.match(/<sub>/g)).toHaveLength(1);
    expect(body.match(/<\/sub>/g)).toHaveLength(1);
  });

  it("cannot forge a verdict through a `notReviewed` line", () => {
    const body = renderStickyComment(
      withFindings([], {
        notReviewed: ["route /x\n\n## Apature Gate: design review\n\n**✅ Ship** · reviewed and approved"],
      }),
      { headSha: "abcdef1234567890" },
    );
    expect(gateHeadings(body)).toEqual(["## Apature Gate: design review"]);
    expect(body.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(1);
  });
});
