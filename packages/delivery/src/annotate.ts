import type { Severity } from "@gate/types";
import sharp from "sharp";

/**
 * Annotated screenshots (TRD §7.1). Boxes are drawn from **recorded DOM geometry
 * rects** (from the engine's capture geometry map), never from VLM-predicted
 * pixel coordinates — so the box always lands on the real element. Gate composites
 * an SVG overlay onto the base screenshot with `sharp`.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Annotation {
  /** Recorded element geometry, in screenshot pixel space. */
  rect: Rect;
  severity?: Severity;
  label?: string;
}

const SEVERITY_COLORS: Record<Severity, string> = {
  blocker: "#E5484D",
  major: "#E5484D",
  minor: "#FFB224",
  nit: "#8B8D98",
};

const DEFAULT_COLOR = "#E5484D";

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Clamp a rect to the image bounds so a stray geometry value can't overflow. */
function clampRect(rect: Rect, width: number, height: number): Rect {
  const x = Math.max(0, Math.min(rect.x, width));
  const y = Math.max(0, Math.min(rect.y, height));
  return {
    x,
    y,
    width: Math.max(0, Math.min(rect.width, width - x)),
    height: Math.max(0, Math.min(rect.height, height - y)),
  };
}

/** Build the SVG overlay (pure; testable without sharp). */
export function buildAnnotationSvg(width: number, height: number, annotations: Annotation[]): string {
  const shapes = annotations
    .map((a) => {
      const r = clampRect(a.rect, width, height);
      const color = a.severity ? SEVERITY_COLORS[a.severity] : DEFAULT_COLOR;
      const box = `<rect x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" fill="none" stroke="${color}" stroke-width="3" rx="2"/>`;
      const label = a.label
        ? `<text x="${r.x + 4}" y="${Math.max(r.y - 6, 12)}" font-family="sans-serif" font-size="14" font-weight="600" fill="${color}">${escapeXml(a.label)}</text>`
        : "";
      return box + label;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${shapes}</svg>`;
}

/**
 * Composite annotation boxes onto a screenshot and return a PNG buffer. Reads the
 * image dimensions from the base image; annotations use recorded geometry.
 */
export async function annotateScreenshot(
  input: Buffer,
  annotations: Annotation[],
): Promise<Buffer> {
  const meta = await sharp(input).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  const overlay = Buffer.from(buildAnnotationSvg(width, height, annotations));
  return sharp(input)
    .composite([{ input: overlay, top: 0, left: 0 }])
    .png()
    .toBuffer();
}
