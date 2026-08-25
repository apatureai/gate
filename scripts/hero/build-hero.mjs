// Renders the real `pnpm demo:review` output into the README hero:
// the sticky PR comment (out/review-comment.md) beside the annotated
// screenshot (out/annotated-f_001.png), screenshotted with the Chromium
// that verdict's checkout installed. No invented bytes: the comment is
// read verbatim from out/review-comment.md.
//
// Usage: node scripts/hero/build-hero.mjs
// Requires: `pnpm demo:review` has been run (populates ./out), and a
// playwright-core Chromium is available (see docs/development.md).

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

const PWC =
  process.env.GATE_PLAYWRIGHT_CORE ||
  "/Users/adityaprathapa/apature-product-repos/verdict/node_modules/.pnpm/playwright-core@1.62.1/node_modules/playwright-core";
const { createRequire } = await import("node:module");
const require = createRequire(import.meta.url);
const { chromium } = require(PWC);

const root = resolve(import.meta.dirname, "..", "..");
const commentMd = readFileSync(resolve(root, "out/review-comment.md"), "utf8");
const shotB64 = readFileSync(resolve(root, "out/annotated-f_001.png")).toString("base64");

// Minimal GitHub-flavored inline renderer for the exact constructs the
// sticky comment emits: bold, inline code, links, and backslash-escaped
// punctuation (GitHub unescapes \( \) \` \- before rendering).
function inline(s) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && i + 1 < s.length && "()`-\\".includes(s[i + 1])) {
      out += esc(s[++i]);
      continue;
    }
    if (c === "`") {
      const end = s.indexOf("`", i + 1);
      if (end !== -1) {
        out += `<code>${esc(s.slice(i + 1, end).replace(/\\`/g, "`"))}</code>`;
        i = end;
        continue;
      }
    }
    if (c === "*" && s[i + 1] === "*") {
      const end = s.indexOf("**", i + 2);
      if (end !== -1) {
        out += `<strong>${inline(s.slice(i + 2, end))}</strong>`;
        i = end + 1;
        continue;
      }
    }
    if (c === "[") {
      const close = s.indexOf("]", i);
      if (close !== -1 && s[close + 1] === "(") {
        const paren = s.indexOf(")", close + 2);
        if (paren !== -1) {
          const text = s.slice(i + 1, close);
          const href = s.slice(close + 2, paren);
          out += `<a href="${esc(href)}">${inline(text)}</a>`;
          i = paren;
          continue;
        }
      }
    }
    out += esc(c);
  }
  return out;
}
function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Block renderer. Passes raw HTML lines (<details>, <summary>, <sub>)
// through unchanged, drops the hidden sticky marker, groups `- ` runs
// into <ul>, and renders ## / ### headings and paragraphs.
function renderComment(md) {
  const lines = md.split("\n");
  const html = [];
  let list = null;
  let para = [];
  const flushPara = () => {
    if (para.length) {
      html.push(`<p>${inline(para.join(" "))}</p>`);
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      html.push(`<ul>${list.join("")}</ul>`);
      list = null;
    }
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (line.startsWith("<!--")) continue;
    if (line === "") {
      flushPara();
      flushList();
      continue;
    }
    if (/^<\/?(details|summary|sub|sup)/.test(line)) {
      flushPara();
      flushList();
      html.push(line.replace(/<summary>(.*?)<\/summary>/, (_, t) => `<summary>${inline(t)}</summary>`));
      continue;
    }
    if (line.startsWith("### ")) {
      flushPara();
      flushList();
      html.push(`<h3>${inline(line.slice(4))}</h3>`);
      continue;
    }
    if (line.startsWith("## ")) {
      flushPara();
      flushList();
      html.push(`<h2>${inline(line.slice(3))}</h2>`);
      continue;
    }
    if (line.startsWith("- ")) {
      flushPara();
      list = list || [];
      list.push(`<li>${inline(line.slice(2))}</li>`);
      continue;
    }
    para.push(line);
  }
  flushPara();
  flushList();
  return html.join("\n");
}

const commentHtml = renderComment(commentMd);

const page = `<!doctype html><html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  body { margin: 0; background: #010409; }
  .hero { display: flex; gap: 22px; align-items: flex-start; padding: 26px;
          background: #010409; width: max-content; }
  .comment { width: 620px; background: #0d1117; border: 1px solid #30363d;
             border-radius: 8px; padding: 16px 18px 8px;
             font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
             font-size: 14px; line-height: 1.55; color: #e6edf3; }
  .comment h2 { font-size: 20px; font-weight: 600; margin: 4px 0 14px;
                padding-bottom: 8px; border-bottom: 1px solid #21262d; }
  .comment h3 { font-size: 14px; font-weight: 600; margin: 18px 0 6px; color: #e6edf3; }
  .comment p { margin: 10px 0; }
  .comment ul { margin: 6px 0; padding-left: 22px; }
  .comment li { margin: 6px 0; }
  .comment code { background: #6e768166; border-radius: 6px; padding: 1px 6px;
                  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 12px; }
  .comment a { color: #4493f8; text-decoration: none; }
  .comment strong { font-weight: 600; }
  .comment details { margin: 10px 0; }
  .comment summary { cursor: pointer; color: #4493f8; font-weight: 600; }
  .comment sub { display: block; margin: 14px 0 8px; color: #8b949e; font-size: 12px; }
  .shot { display: flex; flex-direction: column; gap: 8px; align-items: center; }
  .shot .card { border: 1px solid #30363d; border-radius: 8px; overflow: hidden; background: #0d1117; }
  .shot img { display: block; width: 300px; height: auto; }
  .shot .cap { color: #8b949e; font-size: 12px;
               font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
</style></head><body>
  <div class="hero">
    <div class="comment">${commentHtml}</div>
    <div class="shot">
      <div class="card"><img src="data:image/png;base64,${shotB64}" alt="annotated screenshot"></div>
      <div class="cap">out/annotated-f_001.png</div>
    </div>
  </div>
</body></html>`;

// The rendered HTML is a throwaway intermediate (it inlines the screenshot as
// a base64 data URI); write it to a temp path so it is never committed.
const htmlPath = resolve(tmpdir(), "gate-hero-source.html");
writeFileSync(htmlPath, page);

const browser = await chromium.launch();
const ctx = await browser.newContext({ deviceScaleFactor: 2 });
const p = await ctx.newPage();
await p.goto("file://" + htmlPath);
// Open the <details> disclosures so the whole review is visible in one frame.
// Passed as a string so the browser-scoped `document` reference is not linted
// as a Node global in this script.
await p.evaluate("document.querySelectorAll('details').forEach((d) => (d.open = true))");
const el = await p.$(".hero");
await el.screenshot({ path: resolve(root, "docs/assets/hero.png") });
await browser.close();
console.log("wrote docs/assets/hero.png");
