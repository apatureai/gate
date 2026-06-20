import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { annotateScreenshot, buildAnnotationSvg } from "../src/index.js";

describe("buildAnnotationSvg", () => {
  it("draws a box from a recorded rect with severity color", () => {
    const svg = buildAnnotationSvg(200, 100, [
      { rect: { x: 10, y: 20, width: 50, height: 30 }, severity: "blocker", label: "Contrast" },
    ]);
    expect(svg).toContain('width="200"');
    expect(svg).toContain('<rect x="10" y="20" width="50" height="30"');
    expect(svg).toContain('stroke="#E5484D"'); // blocker color
    expect(svg).toContain("Contrast");
  });

  it("clamps rects to the image bounds (geometry can't overflow)", () => {
    const svg = buildAnnotationSvg(100, 100, [{ rect: { x: 80, y: 80, width: 999, height: 999 } }]);
    expect(svg).toContain('width="20" height="20"'); // clamped to remaining space
  });

  it("escapes label text", () => {
    const svg = buildAnnotationSvg(100, 100, [{ rect: { x: 0, y: 0, width: 10, height: 10 }, label: "<b>&" }]);
    expect(svg).toContain("&lt;b&gt;&amp;");
    expect(svg).not.toContain("<b>&<");
  });
});

describe("annotateScreenshot", () => {
  it("composites boxes onto the base image and returns a valid PNG", async () => {
    const base = await sharp({ create: { width: 200, height: 120, channels: 3, background: "#ffffff" } })
      .png()
      .toBuffer();

    const out = await annotateScreenshot(base, [
      { rect: { x: 10, y: 10, width: 60, height: 40 }, severity: "major", label: "Spacing" },
    ]);

    const meta = await sharp(out).metadata();
    expect(meta.format).toBe("png");
    expect(meta.width).toBe(200);
    expect(meta.height).toBe(120);
    expect(out.length).toBeGreaterThan(0);
  });
});
