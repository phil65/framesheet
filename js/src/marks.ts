/**
 * Marks (`marks` option): validation, which marks are active on a tile, and the pure
 * layout of tile overlays and the timeline strip under a video sheet (port of marks.py).
 *
 * Layout functions return draw ops with integer coordinates and no font measuring (text
 * widths are estimated from the character count), so they match the Python ops exactly
 * (checked against ../schema/golden/layout/marks_layout.json).
 */

import { readFileSync } from "node:fs";
import type { DrawOp } from "./compose.js";
import type { MarkPoint, MarkRegion, Marks, MarkSpan, Rect } from "./models.js";
import { fixed, g } from "./pyfmt.js";

type RGB = [number, number, number];
export const CHAR_W = 0.58;
export const ELLIPSIS = "…";
const INK: RGB = [17, 24, 39];
const MUTED: RGB = [75, 85, 99];
const WHITE: RGB = [255, 255, 255];
const POINT: RGB = [236, 72, 153];
const POINT_TEXT: RGB = [190, 24, 93];
const REGION: RGB = [34, 211, 238];
const REGION_BAR: RGB = [8, 145, 178];
const SPAN_BOX: RGB = [167, 139, 250];
const SPAN_BAR: RGB = [124, 58, 237];
const STATIC: RGB = [245, 158, 11];
const CUT: RGB = [220, 38, 38];
const LANE_BG: RGB = [241, 245, 249];
const GUIDE: RGB = [203, 213, 225];
const TICK: RGB = [190, 18, 60];
const BAR: RGB = [71, 85, 105];
const BORDER: RGB = [100, 116, 139];
const PAD = 12;
const LABEL_COL = 76;
const ROW_H = 22;
const MAX_ROWS = 3;
const NICE_STEPS = [0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];

// Validation ------------------------------------------------------------------------------

export class MarksError extends Error {
  constructor(message: string) {
    super(`Invalid marks: ${message}`);
    this.name = "MarksError";
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function keys(where: string, obj: Record<string, unknown>, allowed: string[]): void {
  const extra = Object.keys(obj).filter((k) => !allowed.includes(k));
  if (extra.length) throw new MarksError(`${where}: unknown field(s) ${extra.join(", ")}`);
}

function num(where: string, obj: Record<string, unknown>, key: string, opts: { min?: number; gt?: number; optional?: boolean; nullable?: boolean } = {}): number | null {
  const v = obj[key];
  if (v === undefined || (v === null && opts.nullable)) {
    if (opts.optional || opts.nullable) return null;
    throw new MarksError(`${where}.${key} is required`);
  }
  if (!isNum(v)) throw new MarksError(`${where}.${key} must be a number`);
  if (opts.min !== undefined && v < opts.min) throw new MarksError(`${where}.${key} must be >= ${opts.min}`);
  if (opts.gt !== undefined && !(v > opts.gt)) throw new MarksError(`${where}.${key} must be > ${opts.gt}`);
  return v;
}

function str(where: string, obj: Record<string, unknown>, key: string, required = false): string | null {
  const v = obj[key];
  if (v === undefined || v === null) {
    if (required) throw new MarksError(`${where}.${key} is required`);
    return null;
  }
  if (typeof v !== "string") throw new MarksError(`${where}.${key} must be a string`);
  return v;
}

function box(where: string, obj: Record<string, unknown>) {
  const x = num(where, obj, "x", { nullable: true });
  const y = num(where, obj, "y", { nullable: true });
  const w = num(where, obj, "w", { nullable: true, gt: 0 });
  const h = num(where, obj, "h", { nullable: true, gt: 0 });
  const given = [x, y, w, h].map((v) => v !== null);
  if (given.some(Boolean) && !given.every(Boolean)) throw new MarksError(`${where}: x, y, w, h must be given together (or not at all)`);
  return { x, y, w, h };
}

function range(where: string, obj: Record<string, unknown>) {
  const start = num(where, obj, "start", { min: 0 })!;
  const end = num(where, obj, "end", { min: 0 })!;
  if (end < start) throw new MarksError(`${where}: end must be >= start`);
  return { start, end };
}

function list(where: string, value: unknown): Record<string, unknown>[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new MarksError(`${where} must be a list`);
  return value.map((item, i) => {
    if (!isObj(item)) throw new MarksError(`${where}[${i}] must be an object`);
    return item;
  });
}

/** Validate marks (same rules as the Python `Marks` model and ../schema/marks.schema.json). */
export function parseMarks(value: unknown): Marks {
  if (!isObj(value)) throw new MarksError("must be a JSON object");
  keys("marks", value, ["frame", "points", "regions", "spans"]);
  let frame: Marks["frame"] = null;
  if (value.frame !== undefined && value.frame !== null) {
    if (!isObj(value.frame)) throw new MarksError("frame must be an object");
    keys("frame", value.frame, ["width", "height"]);
    frame = { width: num("frame", value.frame, "width", { gt: 0 })!, height: num("frame", value.frame, "height", { gt: 0 })! };
  }
  const points: MarkPoint[] = list("points", value.points).map((p, i) => {
    const where = `points[${i}]`;
    keys(where, p, ["t", "x", "y", "label", "kind", "duration"]);
    return {
      t: num(where, p, "t", { min: 0 })!,
      x: num(where, p, "x")!,
      y: num(where, p, "y")!,
      label: str(where, p, "label"),
      kind: str(where, p, "kind"),
      duration: num(where, p, "duration", { min: 0, optional: true }) ?? 0,
    };
  });
  const regions: MarkRegion[] = list("regions", value.regions).map((r, i) => {
    const where = `regions[${i}]`;
    keys(where, r, ["start", "end", "label", "kind", "x", "y", "w", "h"]);
    return { ...box(where, r), ...range(where, r), label: str(where, r, "label"), kind: str(where, r, "kind") };
  });
  const spans: MarkSpan[] = list("spans", value.spans).map((s, i) => {
    const where = `spans[${i}]`;
    keys(where, s, ["start", "end", "label", "kind", "x", "y", "w", "h"]);
    return { ...box(where, s), ...range(where, s), label: str(where, s, "label", true)!, kind: str(where, s, "kind") };
  });
  const [fw, fh] = frame ? [frame.width, frame.height] : [1, 1];
  const check = (where: string, x: number, y: number, w: number, h: number) => {
    const tol = 1e-6;
    if (x < -tol || y < -tol || x + w > fw * (1 + tol) + tol || y + h > fh * (1 + tol) + tol) {
      throw new MarksError(`${where}: coordinates outside ${fw !== 1 || fh !== 1 ? "the frame" : "0-1"}`);
    }
  };
  points.forEach((p, i) => check(`points[${i}]`, p.x, p.y, 0, 0));
  regions.forEach((r, i) => r.x !== null && check(`regions[${i}]`, r.x, r.y!, r.w!, r.h!));
  spans.forEach((s, i) => s.x !== null && check(`spans[${i}]`, s.x, s.y!, s.w!, s.h!));
  return { frame, points, regions, spans };
}

/** Marks from a path, a JSON string or an object. */
export function loadMarks(value: string | Marks | Record<string, unknown>): Marks {
  if (typeof value !== "string") return parseMarks(value);
  const text = value.trimStart().startsWith("{") ? value : readFileSync(value, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new MarksError(`not valid JSON (${(err as Error).message})`);
  }
  return parseMarks(parsed);
}

// Activity --------------------------------------------------------------------------------

const boxOf = (m: { x: number | null; y: number | null; w: number | null; h: number | null }): Rect | null =>
  m.x === null || m.y === null || m.w === null || m.h === null ? null : [m.x, m.y, m.w, m.h];

export function norm(marks: Marks, x: number, y: number): [number, number] {
  return marks.frame ? [x / marks.frame.width, y / marks.frame.height] : [x, y];
}

const chars = (text: string) => Array.from(text);

export function estWidth(text: string, size: number): number {
  return Math.ceil(chars(text).length * size * CHAR_W);
}

/** Truncate `text` (with an ellipsis) to an estimated width of `maxW` px. */
export function fit(text: string, size: number, maxW: number): string {
  const n = Math.floor(maxW / (size * CHAR_W));
  const cs = chars(text);
  if (cs.length <= n) return text;
  if (n < 2) return "";
  return cs.slice(0, n - 1).join("") + ELLIPSIS;
}

/** Time window each tile stands for: halfway to its neighbours (range ends outside). */
export function tileWindows(times: number[], start: number, end: number): [number, number][] {
  return times.map((t, i) => [i === 0 ? start : (times[i - 1] + t) / 2, i === times.length - 1 ? end : (t + times[i + 1]) / 2]);
}

export function pointActive(p: MarkPoint, [lo, hi]: [number, number], last: boolean): boolean {
  const a = p.t;
  const b = p.t + p.duration;
  return (last ? a <= hi : a < hi) && b >= lo;
}

const pointLabel = (p: MarkPoint) => `${p.label || p.kind || "point"} @${fixed(p.t, 2)}s`;
const regionLabel = (r: MarkRegion) => r.label || r.kind || "region";

/** Labels of all marks active on a tile (spans, regions, points). */
export function activeLabels(marks: Marks, t: number, window: [number, number], last: boolean): string[] {
  return [
    ...marks.spans.filter((s) => s.start <= t && t <= s.end).map((s) => s.label),
    ...marks.regions.filter((r) => r.start <= t && t <= r.end).map(regionLabel),
    ...marks.points.filter((p) => pointActive(p, window, last)).map(pointLabel),
  ];
}

/** Second label line of a tile: active spans and box-less regions. */
export function bandText(marks: Marks, t: number): string {
  return [
    ...marks.spans.filter((s) => s.start <= t && t <= s.end).map((s) => s.label),
    ...marks.regions.filter((r) => boxOf(r) === null && r.start <= t && t <= r.end).map(regionLabel),
  ].join("  |  ");
}

export function hasBand(marks: Marks): boolean {
  return marks.spans.length > 0 || marks.regions.some((r) => boxOf(r) === null);
}

// Tile overlays ---------------------------------------------------------------------------

type Box4 = [number, number, number, number];

function clip(box: Box4, w: number, h: number): Box4 | null {
  const c: Box4 = [Math.max(0, box[0]), Math.max(0, box[1]), Math.min(w - 1, box[2]), Math.min(h - 1, box[3])];
  return c[0] <= c[2] && c[1] <= c[3] ? c : null;
}

function rect(ops: DrawOp[], box: Box4, fill: RGB, w: number, h: number): void {
  const c = clip(box, w, h);
  if (c) ops.push({ op: "rect", box: c, fill });
}

function outline(ops: DrawOp[], box: Box4, color: RGB, width: number, w: number, h: number): void {
  const c = clip(box, w, h);
  if (c) ops.push({ op: "outline", box: c, color, width });
}

function tag(ops: DrawOp[], text: string, x: number, y: number, fill: RGB, color: RGB, w: number, h: number): void {
  if (!text) return;
  const tw = estWidth(text, 13) + 8;
  x = Math.max(0, Math.min(x, w - tw));
  y = Math.max(0, Math.min(y, h - 18));
  rect(ops, [x, y, x + tw - 1, y + 17], fill, w, h);
  ops.push({ op: "text", x: x + 4, y: y + 2, text, color, size: 13 });
}

/** Overlay ops for one tile image of `size` px; `content` = frame area in the viewport (CSS px). */
export function tileOps(
  marks: Marks,
  t: number,
  window: [number, number],
  last: boolean,
  opts: { size: [number, number]; viewport: [number, number]; content: Rect },
): DrawOp[] {
  const [w, h] = opts.size;
  const sx = w / opts.viewport[0];
  const sy = h / opts.viewport[1];
  const [cx, cy, cw, ch] = opts.content;
  const at = (nx: number, ny: number): [number, number] => {
    const [fx, fy] = norm(marks, nx, ny);
    return [Math.floor((cx + fx * cw) * sx), Math.floor((cy + fy * ch) * sy)];
  };
  const ops: DrawOp[] = [];
  const boxed: [Rect, RGB, string][] = [];
  for (const r of marks.regions) {
    const b = boxOf(r);
    if (b && r.start <= t && t <= r.end) boxed.push([b, REGION, regionLabel(r)]);
  }
  for (const s of marks.spans) {
    const b = boxOf(s);
    if (b && s.start <= t && t <= s.end) boxed.push([b, SPAN_BOX, s.label]);
  }
  for (const [[bx, by, bw, bh], color, label] of boxed) {
    const [x0, y0] = at(bx, by);
    let [x1, y1] = at(bx + bw, by + bh);
    x1 = Math.max(x0, x1 - 1);
    y1 = Math.max(y0, y1 - 1);
    outline(ops, [x0 - 1, y0 - 1, x1 + 1, y1 + 1], INK, 1, w, h);
    outline(ops, [x0, y0, x1, y1], color, 2, w, h);
    tag(ops, fit(label, 13, Math.max(60, x1 - x0)), x0, y0 >= 18 ? y0 - 18 : y0 + 2, color, INK, w, h);
  }
  for (const p of marks.points) {
    if (!pointActive(p, window, last)) continue;
    const [x, y] = at(p.x, p.y);
    outline(ops, [x - 7, y - 7, x + 7, y + 7], INK, 1, w, h);
    outline(ops, [x - 6, y - 6, x + 6, y + 6], POINT, 2, w, h);
    const ticks: Box4[] = [
      [x - 12, y - 1, x - 8, y + 1],
      [x + 8, y - 1, x + 12, y + 1],
      [x - 1, y - 12, x + 1, y - 8],
      [x - 1, y + 8, x + 1, y + 12],
      [x - 1, y - 1, x + 1, y + 1],
    ];
    for (const b of ticks) rect(ops, b, POINT, w, h);
    const text = fit(pointLabel(p), 13, 220);
    const tw = estWidth(text, 13) + 8;
    const tx = x + 14 + tw <= w ? x + 14 : x - 14 - tw;
    tag(ops, text, tx, y - 9, POINT, WHITE, w, h);
  }
  return ops;
}

// Timeline --------------------------------------------------------------------------------

export interface Issue {
  kind: "static" | "black" | "blank" | "cut";
  start: number;
  end: number;
}

function niceStep(span: number, width: number): number {
  for (const step of NICE_STEPS) if (span / step <= width / 90) return step;
  return NICE_STEPS[NICE_STEPS.length - 1];
}

/** Greedy row per item extent `[x0, x1]` (items sorted by x0), at most MAX_ROWS. */
function rows(items: [number, number][]): number[] {
  const ends: number[] = [];
  const out: number[] = [];
  for (const [x0, x1] of items) {
    let row = ends.findIndex((end) => end + 6 <= x0);
    if (row < 0) {
      if (ends.length < MAX_ROWS) {
        row = ends.length;
        ends.push(x1);
      } else {
        row = 0;
        for (let r = 1; r < ends.length; r++) if (ends[r] < ends[row]) row = r;
      }
    }
    ends[row] = Math.max(ends[row], x1);
    out.push(row);
  }
  return out;
}

/** The timeline strip: motion, issues, spans, regions, points, tile axis. Returns `[height, ops]`. */
export function timelineOps(
  width: number,
  start: number,
  end: number,
  times: number[],
  opts: { marks?: Marks | null; activity?: [number, number][] | null; issues?: Issue[] | null } = {},
): [number, DrawOp[]] {
  const { marks = null, activity = null, issues = null } = opts;
  const left = PAD + LABEL_COL;
  const right = width - PAD - 1;
  const span = Math.max(end - start, 1e-9);
  const X = (t: number) => left + Math.floor(Math.min(1, Math.max(0, (t - start) / span)) * (right - left));
  const back: DrawOp[] = [];
  const front: DrawOp[] = [];
  const title =
    `timeline ${fixed(start, 2)}-${fixed(end, 2)}s: tiles #1-#${times.length}` +
    (activity !== null ? "; motion = changed pixels per sample" : "");
  front.push({ op: "text", x: PAD, y: 8, text: title, color: INK, size: 16 });
  let y = 34;
  const lanesTop = y;
  const lane = (name: string, height: number): number => {
    const top = y;
    back.push({ op: "rect", box: [left, top, right, top + height - 1], fill: LANE_BG });
    front.push({ op: "text", x: PAD, y: top + Math.floor((height - 13) / 2) - 1, text: name, color: MUTED, size: 13 });
    y += height + 4;
    return top;
  };
  if (activity !== null) {
    const h = 34;
    const top = lane("motion", h);
    for (let k = 1; k < activity.length; k++) {
      const ratio = activity[k][1];
      if (ratio <= 0) continue;
      const bh = Math.max(1, Math.floor(h * Math.min(1, Math.sqrt(ratio / 0.25))));
      const x0 = X(activity[k - 1][0]);
      const x1 = X(activity[k][0]);
      front.push({ op: "rect", box: [x0, top + h - bh, Math.max(x0, x1 - 1), top + h - 1], fill: BAR });
    }
  }
  if (issues !== null) {
    const h = 20;
    const top = lane("issues", h);
    if (!issues.length) front.push({ op: "text", x: left + 4, y: top + 3, text: "none", color: MUTED, size: 12 });
    for (const issue of issues) {
      const x0 = X(issue.start);
      const x1 = X(issue.end);
      if (issue.kind === "static") {
        front.push({ op: "rect", box: [x0, top + 3, Math.max(x0 + 1, x1), top + 16], fill: STATIC });
        const text = fit(`static ${fixed(issue.end - issue.start, 1)}s`, 12, x1 - x0 - 4);
        if (text) front.push({ op: "text", x: x0 + 3, y: top + 3, text, color: INK, size: 12 });
      } else if (issue.kind === "black" || issue.kind === "blank") {
        const box: Box4 = [x0, top + 2, Math.max(x1, x0 + 3), top + h - 3];
        front.push({ op: "rect", box, fill: issue.kind === "black" ? [0, 0, 0] : WHITE });
        if (issue.kind === "blank") front.push({ op: "outline", box, color: BORDER, width: 1 });
      } else if (issue.kind === "cut") {
        front.push({ op: "rect", box: [x0 - 1, top, x0, top + h - 1], fill: CUT });
      }
    }
  }
  if (marks !== null) {
    const bars: [string, [number, number, string][], RGB][] = [
      ["spans", marks.spans.map((s) => [s.start, s.end, s.label]), SPAN_BAR],
      ["regions", marks.regions.map((r) => [r.start, r.end, regionLabel(r)]), REGION_BAR],
    ];
    for (const [name, raw, color] of bars) {
      if (!raw.length) continue;
      // Stable sort by (start, end), like Python's sorted().
      const items = raw.map((it, i) => [it, i] as const).sort((a, b) => a[0][0] - b[0][0] || a[0][1] - b[0][1] || a[1] - b[1]).map(([it]) => it);
      const geo = items.map(([s, e, label]) => {
        const x0 = X(s);
        const x1 = Math.max(X(e), X(s) + 2);
        const inside = fit(label, 13, x1 - x0 - 8);
        const outside = chars(inside).length < Math.min(4, chars(label).length);
        const text = outside ? fit(label, 13, 200) : inside;
        const extent = outside ? x1 + 4 + estWidth(text, 13) : x1;
        return { x0, x1, text, outside, extent };
      });
      const rs = rows(geo.map((gm) => [gm.x0, gm.extent]));
      const top = lane(name, (Math.max(...rs) + 1) * ROW_H);
      geo.forEach((gm, i) => {
        const ry = top + rs[i] * ROW_H;
        front.push({ op: "rect", box: [gm.x0, ry + 2, gm.x1, ry + 19], fill: color });
        if (gm.text) {
          front.push({
            op: "text",
            x: gm.outside ? gm.x1 + 4 : gm.x0 + 4,
            y: ry + 4,
            text: gm.text,
            color: gm.outside ? color : WHITE,
            size: 13,
          });
        }
      });
    }
    if (marks.points.length) {
      const pts = marks.points.map((p, i) => [p, i] as const).sort((a, b) => a[0].t - b[0].t || a[1] - b[1]).map(([p]) => p);
      const geo = pts.map((p) => ({ x: X(p.t), text: fit(p.label || p.kind || "", 13, 200), xEnd: X(p.t + p.duration) }));
      const rs = rows(geo.map((gm) => [gm.x - 2, Math.max(gm.xEnd, gm.x + 5 + estWidth(gm.text, 13))]));
      const top = lane("points", (Math.max(...rs) + 1) * ROW_H);
      geo.forEach((gm, i) => {
        const ry = top + rs[i] * ROW_H;
        if (gm.xEnd > gm.x) front.push({ op: "rect", box: [gm.x, ry + 9, gm.xEnd, ry + 12], fill: POINT });
        front.push({ op: "rect", box: [gm.x - 1, ry + 2, gm.x + 1, ry + 19], fill: POINT });
        if (gm.text) front.push({ op: "text", x: gm.x + 5, y: ry + 4, text: gm.text, color: POINT_TEXT, size: 13 });
      });
    }
  }
  const lanesBottom = y - 4;
  const axis = y + 2;
  front.push({ op: "text", x: PAD, y: axis + 4, text: "tiles", color: MUTED, size: 13 });
  front.push({ op: "rect", box: [left, axis + 14, right, axis + 14], fill: BORDER });
  let lastLabel = -(10 ** 9);
  times.forEach((t, i) => {
    const x = X(t);
    if (lanesBottom > lanesTop) back.push({ op: "rect", box: [x, lanesTop, x, lanesBottom], fill: GUIDE });
    front.push({ op: "rect", box: [x - 1, axis + 4, x, axis + 14], fill: TICK });
    const text = `#${i + 1}`;
    const tw = estWidth(text, 12);
    const tx = x + 2 + tw <= right ? x + 2 : x - 3 - tw; // the end tile: left of its tick
    if (tx >= lastLabel + 4) {
      front.push({ op: "text", x: tx, y: axis, text, color: TICK, size: 12 });
      lastLabel = tx + tw;
    }
  });
  const step = niceStep(span, right - left);
  let k = Math.ceil(start / step - 1e-9) || 0; // no -0 (Python ints)
  lastLabel = -(10 ** 9);
  while (k * step <= end + 1e-9) {
    const v = k * step;
    const x = X(v);
    front.push({ op: "rect", box: [x, axis + 15, x, axis + 19], fill: BORDER });
    const text = `${g(v)}s`;
    const tw = estWidth(text, 12);
    if (x + 2 >= lastLabel + 6 && x + 2 + tw <= width - PAD) {
      front.push({ op: "text", x: x + 2, y: axis + 19, text, color: MUTED, size: 12 });
      lastLabel = x + 2 + tw;
    }
    k++;
  }
  return [axis + 36 + PAD, [...back, ...front]];
}
