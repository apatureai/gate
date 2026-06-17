import { PGlite } from "@electric-sql/pglite";
import { pgliteExecutor, runMigrations } from "@gate/db";
import { loadGoldenReviewResult } from "@gate/types";
import { describe, expect, it } from "vitest";
import { buildFindingBrowser, listRunHistory, prUrl } from "../src/runs.js";

describe("prUrl", () => {
  it("links a run back to its PR", () => {
    expect(prUrl("acme", "web", 42)).toBe("https://github.com/acme/web/pull/42");
  });
});

describe("listRunHistory", () => {
  it("lists a repo's runs newest-first", async () => {
    const db = new PGlite();
    await runMigrations(pgliteExecutor(db));
    await db.exec("INSERT INTO installations (id, account_login, account_id) VALUES (1, 'acme', 10)");
    await db.query(
      "INSERT INTO runs (installation_id, repo_owner, repo_name, pr_number, head_sha, grade, model, created_at) VALUES (1,'acme','web',1,'s1','ship','qwen3-vl', now() - interval '1 hour')",
    );
    await db.query(
      "INSERT INTO runs (installation_id, repo_owner, repo_name, pr_number, head_sha, grade, model, created_at) VALUES (1,'acme','web',2,'s2','needs_work','qwen3-vl', now())",
    );

    const history = await listRunHistory((sql, params) => db.query(sql, params as unknown[]), {
      owner: "acme",
      name: "web",
    });
    expect(history.map((r) => r.prNumber)).toEqual([2, 1]); // newest first
    expect(history[0]).toMatchObject({ grade: "needs_work", model: "qwen3-vl" });
  });
});

describe("buildFindingBrowser", () => {
  it("maps findings to stable screenshot URLs + PR link", () => {
    const result = loadGoldenReviewResult();
    const browser = buildFindingBrowser(result, {
      baseUrl: "https://gate.app/",
      owner: "acme",
      name: "web",
      prNumber: 42,
    });
    expect(browser.prUrl).toBe("https://github.com/acme/web/pull/42");
    expect(browser.grade).toBe(result.grade);

    const withShot = browser.findings.find((f) => f.id === result.artifacts.annotatedScreenshots[0]?.findingId);
    expect(withShot?.screenshotUrl).toBe(`https://gate.app/i/${withShot?.id}.png`);

    // a finding without an annotated screenshot has a null url
    const noShot = browser.findings.find((f) => !result.artifacts.annotatedScreenshots.some((s) => s.findingId === f.id));
    expect(noShot?.screenshotUrl ?? null).toBeNull();
  });
});
