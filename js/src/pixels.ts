/**
 * Pixel math on decoded frames (pure JS, pngjs): diff stats, motion map, heat overlay.
 * Same thresholds and colour ramp as compose.py.
 */

import { PNG } from "pngjs";
import type { Rect } from "./models.js";
import { pyRound } from "./pyfmt.js";

/** Per-channel difference (0-255) below which a pixel counts as unchanged. */
export const DIFF_THRESHOLD = 8;

/** A decoded RGBA frame. */
export interface Frame {
  width: number;
  height: number;
  data: Uint8Array;
}

/** Device-px bounding box `[x0, y0, x1, y1)` (exclusive right/bottom, like Pillow's getbbox). */
export type Box = [number, number, number, number];

export function decode(png: Buffer): Frame {
  const img = PNG.sync.read(png);
  return { width: img.width, height: img.height, data: img.data };
}

export function encode(frame: Frame): Buffer {
  const png = new PNG({ width: frame.width, height: frame.height });
  png.data = Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
  return PNG.sync.write(png, { colorType: 2, inputHasAlpha: true, deflateLevel: 6 });
}

function sameSize(a: Frame, b: Frame): void {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`Frame sizes differ: ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  }
}

/** Per-pixel max RGB channel difference between two frames. */
export function changeMask(a: Frame, b: Frame): Uint8Array {
  sameSize(a, b);
  const n = a.width * a.height;
  const out = new Uint8Array(n);
  const da = a.data;
  const db = b.data;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const r = Math.abs(da[p] - db[p]);
    const g = Math.abs(da[p + 1] - db[p + 1]);
    const bl = Math.abs(da[p + 2] - db[p + 2]);
    out[i] = r > g ? (r > bl ? r : bl) : g > bl ? g : bl;
  }
  return out;
}

/** Share of changed pixels and the bounding box (device px) of the change. */
export function diffStats(a: Frame, b: Frame): [number, Box | null] {
  sameSize(a, b);
  const da = a.data;
  const db = b.data;
  const w = a.width;
  const n = a.width * a.height;
  let count = 0;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -1;
  let y1 = -1;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    let m = Math.abs(da[p] - db[p]);
    let d = Math.abs(da[p + 1] - db[p + 1]);
    if (d > m) m = d;
    d = Math.abs(da[p + 2] - db[p + 2]);
    if (d > m) m = d;
    if (m > DIFF_THRESHOLD) {
      count++;
      const x = i % w;
      const y = (i - x) / w;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return [count / n, count ? [x0, y0, x1 + 1, y1 + 1] : null];
}

export function toCss(box: Box | null, scale: number): Rect | null {
  if (box === null) return null;
  const [x0, y0, x1, y1] = box;
  return [pyRound(x0 / scale, 1), pyRound(y0 / scale, 1), pyRound((x1 - x0) / scale, 1), pyRound((y1 - y0) / scale, 1)];
}

export function union(a: Box, b: Box): Box {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

/**
 * Incremental motion map: per-pixel max change between consecutive frames and vs. the
 * first frame, plus the union of consecutive changed boxes. Frames are fed in time order,
 * so they need not be kept in memory.
 */
export class MotionAccumulator {
  first: Frame | null = null;
  private prev: Frame | null = null;
  acc: Uint8Array | null = null;
  box: Box | null = null;
  count = 0;

  add(frame: Frame): void {
    this.count++;
    if (!this.first) {
      this.first = frame;
      this.prev = frame;
      this.acc = new Uint8Array(frame.width * frame.height);
      return;
    }
    sameSize(this.first, frame);
    const acc = this.acc!;
    const a = this.prev!.data;
    const f0 = this.first.data;
    const c = frame.data;
    const w = frame.width;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -1;
    let y1 = -1;
    // Fused: max channel diff vs. the previous frame (step) and vs. the first frame.
    for (let i = 0, p = 0; i < acc.length; i++, p += 4) {
      const r = c[p];
      const g = c[p + 1];
      const b = c[p + 2];
      let s = Math.abs(r - a[p]);
      let d = Math.abs(g - a[p + 1]);
      if (d > s) s = d;
      d = Math.abs(b - a[p + 2]);
      if (d > s) s = d;
      let m = Math.abs(r - f0[p]);
      d = Math.abs(g - f0[p + 1]);
      if (d > m) m = d;
      d = Math.abs(b - f0[p + 2]);
      if (d > m) m = d;
      if (s > m) m = s;
      if (m > acc[i]) acc[i] = m;
      if (s > DIFF_THRESHOLD) {
        const x = i % w;
        const y = (i - x) / w;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    if (x1 >= 0) {
      const b: Box = [x0, y0, x1 + 1, y1 + 1];
      this.box = this.box ? union(this.box, b) : b;
    }
    this.prev = frame;
  }
}

/** Colour ramp for change strength: violet (subtle) -> red -> orange -> yellow (strong). */
function heatLut(): { rgb: [number, number, number][]; alpha: number[] } {
  const stops: [number, [number, number, number]][] = [
    [0.0, [168, 85, 247]],
    [0.4, [239, 68, 68]],
    [0.7, [249, 115, 22]],
    [1.0, [253, 230, 80]],
  ];
  const rgb: [number, number, number][] = [];
  const alpha: number[] = [];
  for (let v = 0; v < 256; v++) {
    if (v <= DIFF_THRESHOLD) {
      rgb.push([0, 0, 0]);
      alpha.push(0);
      continue;
    }
    const s = Math.min(1, (v - DIFF_THRESHOLD) / 120) ** 0.5;
    let color: [number, number, number] = stops[stops.length - 1][1];
    for (let k = 0; k < stops.length - 1; k++) {
      const [p0, c0] = stops[k];
      const [p1, c1] = stops[k + 1];
      if (s <= p1) {
        const f = (s - p0) / (p1 - p0);
        color = [0, 1, 2].map((j) => pyRound(c0[j] + (c1[j] - c0[j]) * f)) as [number, number, number];
        break;
      }
    }
    rgb.push(color);
    alpha.push(pyRound(170 + 85 * s));
  }
  return { rgb, alpha };
}

export const HEAT_LUT = heatLut();
const BASE_LUT = Array.from({ length: 256 }, (_, v) => pyRound(28 + v * 0.32));

/**
 * Coloured motion overlay on a dimmed, desaturated first frame (full resolution), with
 * `boxes` outlined. Returns an RGBA frame (opaque).
 */
export function heatOverlay(first: Frame, motion: Uint8Array, boxes: Box[], boxColor: [number, number, number]): Frame {
  const { width, height } = first;
  const out = new Uint8Array(width * height * 4);
  const src = first.data;
  const { rgb, alpha } = HEAT_LUT;
  for (let i = 0, p = 0; i < motion.length; i++, p += 4) {
    // Pillow's "L" conversion (ITU-R 601-2 luma, fixed point), then the dim ramp.
    const l = (src[p] * 19595 + src[p + 1] * 38470 + src[p + 2] * 7471 + 0x8000) >> 16;
    const base = BASE_LUT[l];
    const a = alpha[motion[i]];
    if (a === 0) {
      out[p] = out[p + 1] = out[p + 2] = base;
    } else {
      const c = rgb[motion[i]];
      out[p] = Math.round((c[0] * a + base * (255 - a)) / 255);
      out[p + 1] = Math.round((c[1] * a + base * (255 - a)) / 255);
      out[p + 2] = Math.round((c[2] * a + base * (255 - a)) / 255);
    }
    out[p + 3] = 255;
  }
  const stroke = Math.max(2, pyRound(Math.max(width, height) / 300));
  for (const [bx0, by0, bx1, by1] of boxes) outline(out, width, height, [bx0, by0, bx1, by1], stroke, boxColor);
  return { width, height, data: out };
}

/** Pillow's `rectangle(box, outline=, width=)`: inclusive corners, stroke drawn inward. */
function outline(
  data: Uint8Array,
  width: number,
  height: number,
  [x0, y0, x1, y1]: Box,
  stroke: number,
  color: [number, number, number],
): void {
  const set = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const p = (y * width + x) * 4;
    data[p] = color[0];
    data[p + 1] = color[1];
    data[p + 2] = color[2];
  };
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const edge = x - x0 < stroke || x1 - x < stroke || y - y0 < stroke || y1 - y < stroke;
      if (edge) set(x, y);
    }
  }
}
