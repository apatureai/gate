import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DEFAULT_CONFIG } from "@gate/config";
import { annotateScreenshot, type Annotation, type CheckRun, type GitHubCommentsApi, type IssueComment } from "@gate/delivery";
import { createHttpEngineTransport, createJudgmentEngineClient } from "@gate/engine";
import { loadGoldenReviewResult, type GateReviewResult } from "@gate/types";
import { runAction, type ActionOutcome } from "./run.js";

/**
 * Offline run of the Action path's review orchestration, end to end, writing the
 * artifacts a real PR would receive.
 *
 * What is real: `runAction` (preview resolution, handoff verification, the
 * publish-time SHA guard, degradation decisions), the engine client and its
 * `x-schema-version` + Zod parsing, the sticky-comment renderer, the Check Run
 * mapping, and `annotateScreenshot`'s SVG-over-PNG compositing.
 *
 * What is substituted, because it lives in the judgment-engine repo and needs a
 * model endpoint: the engine's HTTP responses (replayed from the golden fixture
 * in `packages/types/fixtures`), the base screenshot (drawn here from an SVG),
 * and the element geometry the boxes are drawn from. Nothing in this module
 * judges a UI; it replays a recorded judgment through the real delivery path.
 */
const MOBILE = { width: 390, height: 844 };

/** Element geometry for the fixture page, as the engine's capture geometry map would supply it. */
const FIXTURE_GEOMETRY: Record<string, Annotation> = {
  f_001: {
    rect: { x: 24, y: 470, width: 342, height: 56 },
    severity: "major",
    label: "f_001 CTA off-palette",
  },
  f_002: {
    rect: { x: 24, y: 566, width: 366, height: 210 },
    severity: "minor",
    label: "f_002 grid overflows 390px",
  },
};

const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";

export interface ReviewDemoScreenshot {
  findingId: string;
  path: string;
  bytes: number;
}

export interface ReviewDemoResult {
  outDir: string;
  outcome: ActionOutcome;
  grade: GateReviewResult["grade"];
  findingCount: number;
  notReviewed: string[];
  commentPath: string;
  commentBytes: number;
  checkRunPath: string;
  checkRun: CheckRun;
  screenshots: ReviewDemoScreenshot[];
}

/** The page the review is about: a fixture pricing screen with a deliberately off-palette CTA. */
function fixturePageSvg(): string {
  const card = (y: number, name: string, price: string): string => `
    <rect x="24" y="${y}" width="366" height="96" rx="10" fill="#ffffff" stroke="#e4e4e7"/>
    <text x="44" y="${y + 36}" font-family="Helvetica, sans-serif" font-size="16" font-weight="600" fill="#18181b">${name}</text>
    <text x="44" y="${y + 66}" font-family="Helvetica, sans-serif" font-size="22" font-weight="700" fill="#18181b">${price}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${MOBILE.width}" height="${MOBILE.height}">
    <rect width="${MOBILE.width}" height="${MOBILE.height}" fill="#fafafa"/>
    <text x="24" y="120" font-family="Helvetica, sans-serif" font-size="30" font-weight="700" fill="#18181b">Pricing</text>
    <text x="24" y="156" font-family="Helvetica, sans-serif" font-size="15" fill="#52525b">Fixture page for the Gate review demo.</text>
    <rect x="24" y="200" width="342" height="240" rx="12" fill="#ffffff" stroke="#e4e4e7"/>
    <text x="44" y="240" font-family="Helvetica, sans-serif" font-size="18" font-weight="600" fill="#18181b">Team plan</text>
    <text x="44" y="286" font-family="Helvetica, sans-serif" font-size="40" font-weight="700" fill="#18181b">$29</text>
    <text x="44" y="320" font-family="Helvetica, sans-serif" font-size="14" fill="#52525b">per editor, per month</text>
    <rect x="24" y="470" width="342" height="56" rx="8" fill="#2563eb"/>
    <text x="118" y="505" font-family="Helvetica, sans-serif" font-size="16" font-weight="600" fill="#ffffff">Start free trial</text>
    ${card(566, "Starter", "$0")}
    ${card(670, "Business", "$79")}
  </svg>`;
}

/** Replays one recorded engine response through the real HTTP transport + parser. */
function replayEngine(result: GateReviewResult) {
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    if (url.endsWith("/jobs") && init.method === "POST") {
      return new Response(JSON.stringify({ jobId: "job_demo" }), { status: 202 });
    }
    return new Response(JSON.stringify({ jobId: "job_demo", state: "completed", result }), {
      status: 200,
      headers: { "x-schema-version": "1" },
    });
  }) as unknown as typeof fetch;
  return createJudgmentEngineClient(createHttpEngineTransport({ baseUrl: "https://engine.invalid", fetchImpl }));
}

/** In-memory stand-in for the GitHub REST surface the Action would post to. */
function inMemoryGitHub() {
  const store: IssueComment[] = [];
  const checkRuns: CheckRun[] = [];
  let nextId = 1;
  const comments: GitHubCommentsApi = {
    listComments: async () => store.map((c) => ({ ...c })),
    createComment: async (body) => {
      const comment = { id: nextId, nodeId: `node_${nextId}`, body };
      nextId += 1;
      store.push(comment);
      return comment;
    },
    updateComment: async (id, body, expectedNodeId) => {
      const comment = store.find((c) => c.id === id);
      if (!comment || comment.nodeId !== expectedNodeId) return { updated: false };
      comment.body = body;
      return { updated: true };
    },
  };
  return { comments, store, checkRuns, publishCheckRun: async (run: CheckRun) => void checkRuns.push(run) };
}

export async function runReviewDemo(options: { outDir?: string } = {}): Promise<ReviewDemoResult> {
  const outDir = resolve(options.outDir ?? "out");
  await mkdir(outDir, { recursive: true });

  // Annotate first: the comment links the artifacts, so they must exist and the
  // recorded result must point at where they landed.
  const golden = loadGoldenReviewResult();
  const base = await renderFixturePage();
  const screenshots: ReviewDemoScreenshot[] = [];
  for (const shot of golden.artifacts.annotatedScreenshots) {
    const annotation = FIXTURE_GEOMETRY[shot.findingId];
    if (!annotation) continue;
    const png = await annotateScreenshot(base, [annotation]);
    const path = resolve(outDir, `annotated-${shot.findingId}.png`);
    await writeFile(path, png);
    screenshots.push({ findingId: shot.findingId, path, bytes: png.byteLength });
  }

  const result: GateReviewResult = {
    ...golden,
    artifacts: {
      ...golden.artifacts,
      annotatedScreenshots: golden.artifacts.annotatedScreenshots.map((shot) => ({
        ...shot,
        url: `./annotated-${shot.findingId}.png`,
      })),
    },
  };

  const gh = inMemoryGitHub();
  const outcome = await runAction(
    DEFAULT_CONFIG,
    { previewUrl: "https://gate-demo-pr7.example.dev", previewCommand: null },
    {
      installationId: "apatureai/gate-demo",
      repository: { owner: "apatureai", name: "gate-demo", defaultBranch: "main" },
      pullRequest: { number: 7, headSha: HEAD_SHA, baseSha: "fedcba9876543210fedcba9876543210fedcba98", title: "Refresh the pricing page", body: null },
      isFork: false,
      previewComments: [],
    },
    {
      engine: replayEngine(result),
      comments: gh.comments,
      getCurrentHeadSha: async () => HEAD_SHA,
      publishCheckRun: gh.publishCheckRun,
    },
  );

  const checkRun = gh.checkRuns.at(-1);
  if (!checkRun) throw new Error("the review demo produced no Check Run");
  const commentBody = gh.store.at(-1)?.body ?? "";
  const commentPath = resolve(outDir, "review-comment.md");
  const checkRunPath = resolve(outDir, "check-run.json");
  await writeFile(commentPath, commentBody);
  await writeFile(checkRunPath, `${JSON.stringify(checkRun, null, 2)}\n`);

  return {
    outDir,
    outcome,
    grade: result.grade,
    findingCount: result.findings.length,
    notReviewed: result.notReviewed,
    commentPath,
    commentBytes: Buffer.byteLength(commentBody),
    checkRunPath,
    checkRun,
    screenshots,
  };
}

/** Rasterize the fixture page to a PNG buffer (sharp, the same library that composites annotations). */
export async function renderFixturePage(): Promise<Buffer> {
  const { default: sharp } = await import("sharp");
  return sharp(Buffer.from(fixturePageSvg())).png().toBuffer();
}

/** Render the demo result as the transcript the CLI prints. Pure. */
export function formatReviewDemoResult(result: ReviewDemoResult, cwd = process.cwd()): string {
  const rel = (path: string): string => (path.startsWith(cwd) ? `.${path.slice(cwd.length)}` : path);
  const out: string[] = [];
  out.push("Gate review demo (recorded engine response, no model call, no network)");
  out.push("");
  out.push(`  PR              apatureai/gate-demo#7 @ ${HEAD_SHA.slice(0, 7)}`);
  out.push(`  engine result   ${result.grade} · ${result.findingCount} findings · ${result.notReviewed.length} areas not reviewed`);
  out.push(`  action status   ${result.outcome.status} · comment ${result.outcome.commentAction ?? "none"}`);
  out.push(`  check run       ${result.checkRun.conclusion} — ${result.checkRun.title}`);
  out.push("");
  out.push("  wrote");
  out.push(`    ${rel(result.commentPath)}  (${result.commentBytes} bytes — the sticky PR comment, verbatim)`);
  out.push(`    ${rel(result.checkRunPath)}  (the Check Run payload)`);
  for (const shot of result.screenshots) {
    out.push(`    ${rel(shot.path)}  (${shot.bytes} bytes — finding ${shot.findingId} boxed on the fixture page)`);
  }
  out.push("");
  out.push("  Open the PNGs to see the annotation boxes; read review-comment.md as GitHub would render it.");
  return out.join("\n");
}
