/**
 * Contact sheet and motion heatmap (port of compose.py's layout).
 *
 * Layout is computed here with the same constants and formulas as the Python package;
 * pixels are drawn on a `<canvas>` in a helper page of the same browser (text with the
 * same Aileron font Pillow bundles, image scaling by Chromium), so there are no native
 * dependencies and the images look like the Python ones.
 */

import type { Browser, BrowserContext, Page } from "playwright-core";
import { FONT_ASCENT_RATIO, FONT_BASE64 } from "./generated/assets.js";
import { type Box, encode, type Frame, HEAT_LUT, heatOverlay } from "./pixels.js";
import { pyRound } from "./pyfmt.js";

type RGB = [number, number, number];
export const SHEET_BG: RGB = [226, 228, 233];
export const INK: RGB = [17, 24, 39];
export const MUTED: RGB = [75, 85, 99];
export const LABEL_BG: RGB = [17, 24, 39];
export const LABEL_FG: RGB = [255, 255, 255];
export const ACCENT_BG: RGB = [190, 18, 60];
export const TILE_BORDER: RGB = [100, 116, 139];
export const BOX_COLOR: RGB = [34, 211, 238];
export const INDEX_FG: RGB = [203, 213, 225];
export const HEADER_H = 66;
export const LABEL_H = 34;
export const GAP = 12;
export const PAD = 12;
export const LABEL_FONT = 22;
export const MARK_BAND_H = 26;
export const MARK_BAND_BG: RGB = [51, 65, 85];
export const MARK_BAND_FG: RGB = [253, 230, 138];
export const MARK_BAND_FONT = 16;
/** Vision models downscale larger images; keep the sheet at or below this width. */
export const MAX_SHEET_WIDTH = 1568;
export const MAX_TILE = 480;
export const MIN_WIDTH = 560;

/** Columns that give a landscape (at least ~4:3) sheet for tiles of `tileAspect` (w/h). */
export function defaultColumns(count: number, tileAspect: number): number {
  const cols = Math.ceil(Math.sqrt((count * 4) / 3 / tileAspect) - 0.25);
  return Math.max(1, Math.min(count, cols));
}

/** Largest tile that keeps `columns` tiles within {@link MAX_SHEET_WIDTH}. */
export function autoTile(columns: number): number {
  return Math.max(120, Math.min(MAX_TILE, Math.floor((MAX_SHEET_WIDTH - 24 - (columns - 1) * 12) / columns) - 2));
}

/** Pillow-style fit: scale to fit `maxW` x `maxH`, keeping the aspect ratio. */
export function fitSize(w: number, h: number, maxW: number, maxH: number): [number, number] {
  const factor = Math.min(maxW / w, maxH / h);
  return [Math.max(1, pyRound(w * factor)), Math.max(1, pyRound(h * factor))];
}

/** One drawing operation, in Pillow coordinates (inclusive rectangles, text anchor "la"). */
export type DrawOp =
  | { op: "rect"; box: [number, number, number, number]; fill: RGB }
  | { op: "outline"; box: [number, number, number, number]; color: RGB; width: number }
  | { op: "text"; x: number; y: number; text: string; color: RGB; size: number; align?: "left" | "right" }
  | { op: "image"; index: number; x: number; y: number; w: number; h: number };

interface DrawSpec {
  width: number;
  height: number;
  background: RGB;
  ops: DrawOp[];
  images: string[];
  ascentRatio: number;
}

const FONT_FAMILY = "framesheet-aileron";

/** Runs in the helper page. */
async function drawInPage(spec: DrawSpec): Promise<string> {
  const w = window as unknown as { __fsFont?: Promise<unknown> };
  await w.__fsFont;
  const canvas = document.createElement("canvas");
  canvas.width = spec.width;
  canvas.height = spec.height;
  const ctx = canvas.getContext("2d")!;
  const css = (c: number[]) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
  ctx.fillStyle = css(spec.background);
  ctx.fillRect(0, 0, spec.width, spec.height);
  const bitmaps = await Promise.all(
    spec.images.map((b64) => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return createImageBitmap(new Blob([bytes], { type: "image/png" }), {
        colorSpaceConversion: "none",
        premultiplyAlpha: "none",
      });
    }),
  );
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  for (const op of spec.ops) {
    if (op.op === "rect") {
      const [x0, y0, x1, y1] = op.box;
      ctx.fillStyle = css(op.fill);
      ctx.fillRect(x0, y0, x1 - x0 + 1, y1 - y0 + 1);
    } else if (op.op === "outline") {
      const [x0, y0, x1, y1] = op.box;
      const s = op.width;
      ctx.fillStyle = css(op.color);
      ctx.fillRect(x0, y0, x1 - x0 + 1, s);
      ctx.fillRect(x0, y1 - s + 1, x1 - x0 + 1, s);
      ctx.fillRect(x0, y0, s, y1 - y0 + 1);
      ctx.fillRect(x1 - s + 1, y0, s, y1 - y0 + 1);
    } else if (op.op === "text") {
      ctx.font = `${op.size}px framesheet-aileron`;
      ctx.fillStyle = css(op.color);
      ctx.textBaseline = "alphabetic";
      const m = ctx.measureText(op.text);
      // Pillow's anchor "la": y is the ascender line, ascender rounded up like FreeType.
      const ascent = Math.ceil(op.size * spec.ascentRatio - 1e-9);
      const x = op.align === "right" ? op.x - m.width : op.x;
      ctx.fillText(op.text, x, op.y + ascent);
    } else if (op.op === "image") {
      const bmp = bitmaps[op.index];
      if (bmp.width === op.w && bmp.height === op.h) ctx.drawImage(bmp, op.x, op.y);
      else ctx.drawImage(bmp, op.x, op.y, op.w, op.h);
    }
  }
  return canvas.toDataURL("image/png").slice("data:image/png;base64,".length);
}

/** Runs in the helper page. */
function measureInPage(items: [string, number][]): number[] {
  const ctx = document.createElement("canvas").getContext("2d")!;
  return items.map(([text, size]) => {
    ctx.font = `${size}px framesheet-aileron`;
    return ctx.measureText(text).width;
  });
}

/**
 * A blank helper page used for parsing (DOMParser) and drawing (canvas). It lives in its
 * own browser context when possible, so it never shares a fake clock or routes with the
 * page under inspection.
 */
export class Renderer {
  private constructor(
    readonly page: Page,
    private readonly ownContext: BrowserContext | null,
  ) {}

  static async open(from: Browser | BrowserContext): Promise<Renderer> {
    const isBrowser = "newContext" in from;
    const context = isBrowser ? await (from as Browser).newContext({ deviceScaleFactor: 1 }) : null;
    const page = context ? await context.newPage() : await (from as BrowserContext).newPage();
    await page.setContent("<!DOCTYPE html><html><head><meta charset='utf-8'></head><body></body></html>");
    await page.evaluate(
      ([family, b64]) => {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const face = new FontFace(family, bytes.buffer);
        document.fonts.add(face);
        (window as unknown as { __fsFont: Promise<unknown> }).__fsFont = face.load();
        return face.load().then(() => true);
      },
      [FONT_FAMILY, FONT_BASE64] as [string, string],
    );
    return new Renderer(page, context);
  }

  async measure(items: [string, number][]): Promise<number[]> {
    return this.page.evaluate(measureInPage, items);
  }

  async draw(width: number, height: number, ops: DrawOp[], images: Buffer[]): Promise<Buffer> {
    const spec: DrawSpec = {
      width,
      height,
      background: SHEET_BG,
      ops,
      images: images.map((b) => b.toString("base64")),
      ascentRatio: FONT_ASCENT_RATIO,
    };
    const b64 = await this.page.evaluate(drawInPage, spec);
    return Buffer.from(b64, "base64");
  }

  async close(): Promise<void> {
    if (this.ownContext) await this.ownContext.close().catch(() => undefined);
    else await this.page.close().catch(() => undefined);
  }
}

function headerOps(title: string, subtitle: string): DrawOp[] {
  return [
    { op: "text", x: PAD, y: 8, text: title, color: INK, size: 24 },
    { op: "text", x: PAD, y: 39, text: subtitle, color: MUTED, size: 18 },
  ];
}

export interface SheetOptions {
  title: string;
  subtitle: string;
  /** Longest side of a tile in px (default: as large as fits 1568 px). */
  tile?: number;
  /** Grid columns (default: roughly 4:3 sheet). */
  columns?: number;
  /** Frame indices whose label gets the accent colour (first/last). */
  highlight?: number[];
  /** Optional second label line per frame (active marks), in an extra MARK_BAND_H band. */
  bands?: string[] | null;
  /** Ops drawn over each tile image (relative to its top-left), given the thumb size. */
  overlay?: ((index: number, thumb: [number, number]) => DrawOp[]) | null;
  /** `(sheet width) -> [height, ops]` appended below the grid (ops relative to its top). */
  footer?: ((width: number) => [number, DrawOp[]]) | null;
}

/** Layout of a contact sheet (pure; exported for tests). */
export function sheetLayout(
  frameSize: [number, number],
  count: number,
  opts: { tile?: number; columns?: number; bandH?: number },
): { width: number; height: number; cols: number; rows: number; tw: number; th: number } {
  const [fw, fh] = frameSize;
  const aspect = fw / fh;
  const cols = opts.columns || defaultColumns(count, aspect);
  const tile = opts.tile || autoTile(cols);
  const [tw, th] = aspect >= 1 ? [tile, pyRound(tile / aspect)] : [pyRound(tile * aspect), tile];
  const rows = Math.ceil(count / cols);
  const cellW = tw + 2;
  const cellH = th + 2 + LABEL_H + (opts.bandH ?? 0);
  const width = Math.max(PAD * 2 + cols * cellW + (cols - 1) * GAP, MIN_WIDTH);
  const height = HEADER_H + PAD + rows * cellH + (rows - 1) * GAP + PAD;
  return { width, height, cols, rows, tw, th };
}

/** Grid of frames, each with a timestamp label band above it. */
export async function contactSheet(
  renderer: Renderer,
  frames: { png: Buffer; width: number; height: number }[],
  labels: string[],
  opts: SheetOptions,
): Promise<Buffer> {
  const bands = opts.bands ?? null;
  const bandH = bands !== null ? MARK_BAND_H : 0;
  const layout = sheetLayout([frames[0].width, frames[0].height], frames.length, { ...opts, bandH });
  const { width, cols, tw, th } = layout;
  const cellW = tw + 2;
  const cellH = th + 2 + LABEL_H + bandH;
  const foot = opts.footer ? opts.footer(width) : null;
  const gridH = layout.height;
  const height = gridH + (foot ? foot[0] : 0);
  const highlight = new Set(opts.highlight ?? []);
  const ops: DrawOp[] = [...headerOps(opts.title, opts.subtitle)];
  frames.forEach((frame, i) => {
    const row = Math.floor(i / cols);
    const col = i % cols;
    const x = PAD + col * (cellW + GAP);
    const y = HEADER_H + PAD + row * (cellH + GAP);
    ops.push({ op: "rect", box: [x, y, x + cellW - 1, y + LABEL_H - 1], fill: highlight.has(i) ? ACCENT_BG : LABEL_BG });
    ops.push({ op: "text", x: x + 8, y: y + 5, text: labels[i], color: LABEL_FG, size: LABEL_FONT });
    ops.push({ op: "text", x: x + cellW - 8, y: y + 10, text: `#${i + 1}`, color: INDEX_FG, size: 16, align: "right" });
    if (bands !== null) {
      const bandY = y + LABEL_H;
      ops.push({ op: "rect", box: [x, bandY, x + cellW - 1, bandY + bandH - 1], fill: MARK_BAND_BG });
      ops.push({ op: "text", x: x + 8, y: bandY + 4, text: bands[i], color: MARK_BAND_FG, size: MARK_BAND_FONT });
    }
    const top = y + LABEL_H + bandH;
    ops.push({ op: "outline", box: [x, top, x + cellW - 1, y + cellH - 1], color: TILE_BORDER, width: 1 });
    const [w, h] = fitSize(frame.width, frame.height, tw, th);
    const ix = x + 1 + Math.floor((tw - w) / 2);
    ops.push({ op: "image", index: i, x: ix, y: top + 1, w, h });
    if (opts.overlay) ops.push(...offsetOps(opts.overlay(i, [w, h]), ix, top + 1));
  });
  if (foot) ops.push(...offsetOps(foot[1], 0, gridH));
  return renderer.draw(
    width,
    height,
    ops,
    frames.map((f) => f.png),
  );
}

export interface HeatmapOptions {
  title: string;
  subtitle: string;
  /** Longest side of the image area (frames are downscaled to fit). */
  maxSide?: number;
  /** Small inputs are upscaled until their longest side reaches this. */
  minSide?: number;
  /** Device-px boxes to outline (e.g. the overall changed region). */
  boxes?: Box[];
}

/** Shift layout ops by `dx, dy`. */
export function offsetOps(ops: DrawOp[], dx: number, dy: number): DrawOp[] {
  return ops.map((op) => {
    if (op.op === "text" || op.op === "image") return { ...op, x: op.x + dx, y: op.y + dy };
    const [x0, y0, x1, y1] = op.box;
    return { ...op, box: [x0 + dx, y0 + dy, x1 + dx, y1 + dy] };
  });
}

/** Coloured motion overlay on a dimmed, desaturated first frame. */
export async function heatmap(
  renderer: Renderer,
  first: Frame,
  motion: Uint8Array,
  opts: HeatmapOptions,
): Promise<Buffer> {
  const maxSide = opts.maxSide ?? 1280;
  const minSide = opts.minSide ?? 800;
  const overlay = heatOverlay(first, motion, opts.boxes ?? [], BOX_COLOR);
  let [iw, ih] = [overlay.width, overlay.height];
  if (Math.max(iw, ih) > maxSide) [iw, ih] = fitSize(iw, ih, maxSide, maxSide);
  else if (Math.max(iw, ih) < minSide) [iw, ih] = fitSize(iw, ih, minSide, minSide);
  const pad = 12;
  const width = Math.max(iw + 2 * pad, MIN_WIDTH);
  const legendH = 34;
  const height = HEADER_H + ih + legendH + pad;
  const ops: DrawOp[] = [...headerOps(opts.title, opts.subtitle)];
  ops.push({ op: "image", index: 0, x: pad, y: HEADER_H, w: iw, h: ih });
  const y = HEADER_H + ih + 8;
  let x = pad;
  const legend: [number, string][] = [
    [20, "subtle"],
    [70, "medium"],
    [255, "strong"],
  ];
  const widths = await renderer.measure(legend.map(([, text]) => [text, 16] as [string, number]));
  legend.forEach(([v, text], i) => {
    ops.push({ op: "rect", box: [x, y + 2, x + 18, y + 20], fill: HEAT_LUT.rgb[v] });
    ops.push({ op: "text", x: x + 24, y: y + 1, text, color: INK, size: 16 });
    x += 34 + pyRound(widths[i]) + 12;
  });
  ops.push({ op: "outline", box: [x, y + 2, x + 18, y + 20], color: BOX_COLOR, width: 3 });
  ops.push({ op: "text", x: x + 24, y: y + 1, text: "changed region", color: INK, size: 16 });
  return renderer.draw(width, height, ops, [encode(overlay)]);
}
