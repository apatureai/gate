import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gateModeEnum } from "@gate/config";
import type { CheckRun, GitHubCommentsApi } from "@gate/delivery";
import { canonicalReviewIdentity, type JudgmentEngineClient } from "@gate/engine";
import { loadGoldenReviewResult } from "@gate/types";
import { describe, expect, it, vi } from "vitest";
import { GATE_MODES, GateModeInputError, resolveActionConfig } from "../src/action-config.js";
import { type ActionRunContext, runAction } from "../src/run.js";

/**
 * `rules.gate: blockers` is the one setting in `.gate.yml` that can fail
 * somebody's build, and on the Action path it was the one setting that could not
 * survive the trip. Two independent reasons, both of which end in the same
 * place: a repository that asked for a merge gate gets a check that cannot fail
 * and never says so, which is exactly the shape of a green check that means
 * nobody enforced anything.
 */

const ACTION_YML = fileURLToPath(new URL("../../../action.yml", import.meta.url));

/**
 * Read one input's keys out of `action.yml`.
 *
 * Hand-rolled rather than a YAML parse because `yaml` is a dependency of
 * `@gate/config`, not of this package, and the shape being read is four lines of
 * fixed indentation. It asserts the block was found, so a reformat that breaks
 * the reader fails the test rather than silently passing it.
 */
function actionInputKeys(name: string): Record<string, string> {
  const lines = readFileSync(ACTION_YML, "utf8").split("\n");
  const start = lines.findIndex((line) => line === `  ${name}:`);
  expect(start, `action.yml has no input named ${name}`).toBeGreaterThanOrEqual(0);
  const keys: Record<string, string> = {};
  for (const line of lines.slice(start + 1)) {
    const match = /^ {4}([a-z-]+):\s*(.*)$/.exec(line);
    if (!match) break;
    keys[match[1] as string] = (match[2] as string).trim();
  }
  return keys;
}

describe("the gate-mode input in action.yml", () => {
  it("has no default, because a default is delivered exactly like a typed value", () => {
    // GitHub substitutes an input's default into `runs.env` when the caller
    // omitted it, so INPUT_GATE_MODE arrives non-empty on every run. With
    // `default: "none"` the entrypoint could not tell "the workflow asked for
    // none" from "the workflow said nothing", and took the file's
    // `rules.gate: blockers` down to `none` on every push.
    expect(actionInputKeys("gate-mode")).not.toHaveProperty("default");
  });

  it("still tells the caller what the input does and what unset means", () => {
    const description = actionInputKeys("gate-mode").description ?? "";
    expect(description).toContain("rules.gate");
    expect(description).toContain("unset");
  });

  it("keeps the inputs that are genuinely defaulted", () => {
    // Narrow, not a blanket ban on defaults: config-path's default is the same
    // value the entrypoint would fall back to anyway, so it overrides nothing.
    expect(actionInputKeys("config-path").default).toBe('".gate.yml"');
  });
});

describe("resolveActionConfig", () => {
  const blockersFile = "rules:\n  gate: blockers\n";

  it("names exactly the gate modes .gate.yml accepts", () => {
    // The Action names the accepted values in its own refusal message rather
    // than importing the schema's zod enum. That is only safe while the two
    // agree, so they are compared here: a mode added to `.gate.yml` and not to
    // the Action would otherwise be refused by the input with a message listing
    // it as unavailable.
    expect([...GATE_MODES]).toEqual([...gateModeEnum.options]);
  });

  it("keeps the file's rules.gate when the input is unset", () => {
    expect(resolveActionConfig(blockersFile, {}).rules.gate).toBe("blockers");
    expect(resolveActionConfig(blockersFile, { gateMode: null }).rules.gate).toBe("blockers");
  });

  it("keeps the file's rules.gate when the input is blank or whitespace", () => {
    expect(resolveActionConfig(blockersFile, { gateMode: "" }).rules.gate).toBe("blockers");
    expect(resolveActionConfig(blockersFile, { gateMode: "   " }).rules.gate).toBe("blockers");
  });

  it("applies an explicit override, in both directions", () => {
    expect(resolveActionConfig(blockersFile, { gateMode: "none" }).rules.gate).toBe("none");
    expect(resolveActionConfig(null, { gateMode: "blockers" }).rules.gate).toBe("blockers");
    expect(resolveActionConfig("rules:\n  gate: none\n", { gateMode: " blockers " }).rules.gate).toBe(
      "blockers",
    );
  });

  it("refuses a value that is not a gate mode, and names it with the accepted set", () => {
    // The near misses are the whole point: every consumer compares the value to
    // the literal "blockers", so `blocker` parsed, published, and was simply
    // never equal to anything.
    for (const typo of ["blocker", "Blockers", "block", "true", "yes"]) {
      const thrown = (() => {
        try {
          resolveActionConfig(blockersFile, { gateMode: typo });
          return null;
        } catch (err) {
          return err;
        }
      })();
      expect(thrown, `gate-mode "${typo}" was accepted`).toBeInstanceOf(GateModeInputError);
      expect((thrown as GateModeInputError).message).toContain(typo);
      for (const mode of GATE_MODES) {
        expect((thrown as GateModeInputError).message).toContain(mode);
      }
    }
  });

  it("keeps a hostile value on one line and bounded before it reaches a Check Run", () => {
    const err = (() => {
      try {
        resolveActionConfig(null, { gateMode: `x`.repeat(200) + "\n```\nnot a gate mode" });
        return null;
      } catch (e) {
        return e as GateModeInputError;
      }
    })();
    expect(err).toBeInstanceOf(GateModeInputError);
    expect(err?.message).not.toContain("\n```");
    expect(err?.message.split("\n")).toHaveLength(1);
  });

  it("still refuses an invalid file, so the input check did not displace the file check", () => {
    expect(() => resolveActionConfig("viewport: [mobile]\n", {})).toThrow(/Invalid \.gate\.yml/);
  });
});

describe("a repository that asked to block, through the Action's own config path", () => {
  const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";
  const golden = loadGoldenReviewResult();

  function harness() {
    const engine: JudgmentEngineClient = {
      review: vi.fn(async (reviewCtx) => ({
        status: "completed" as const,
        result: { ...golden, grade: "blocked" as const },
        jobId: "j",
        reviewIdentity: canonicalReviewIdentity(reviewCtx),
      })),
      cancel: vi.fn(async () => {}),
    };
    const comments: GitHubCommentsApi = {
      listComments: vi.fn(async () => []),
      createComment: vi.fn(async (body) => ({ id: 1, nodeId: "n1", body })),
      updateComment: vi.fn(async () => ({ updated: true })),
    };
    return {
      engine,
      comments,
      getCurrentHeadSha: vi.fn(async () => HEAD_SHA),
      publishCheckRun: vi.fn(async (_run: CheckRun) => {}),
    };
  }

  const ctx: ActionRunContext = {
    installationId: "acme/web",
    repository: { owner: "acme", name: "web", defaultBranch: "main" },
    pullRequest: { number: 42, headSha: HEAD_SHA, baseSha: "def456", title: "Redesign", body: null },
    isFork: false,
    previewComments: [],
  };

  it("fails the check when .gate.yml says blockers and the workflow set no gate-mode", async () => {
    const config = resolveActionConfig("rules:\n  gate: blockers\n", { gateMode: "" });
    const d = harness();
    const outcome = await runAction(
      config,
      { previewUrl: "https://preview.example.com", previewCommand: null },
      ctx,
      d,
    );
    expect(outcome.conclusion).toBe("failure");
  });

  it("goes neutral when the workflow deliberately overrides that file with none", async () => {
    // The override still works; what changed is that it only happens when a
    // human typed it.
    const config = resolveActionConfig("rules:\n  gate: blockers\n", { gateMode: "none" });
    const d = harness();
    const outcome = await runAction(
      config,
      { previewUrl: "https://preview.example.com", previewCommand: null },
      ctx,
      d,
    );
    expect(outcome.conclusion).toBe("neutral");
  });
});
