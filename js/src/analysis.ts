/**
 * Render checks on per-frame geometry (port of analysis.py).
 *
 * Each check is a function `(Geometry) => Finding[]` registered in {@link CHECKS}.
 * Keep the logic, thresholds and messages in step with analysis.py.
 */

import type { AnimationTiming, ElementTrack, Finding, Rect } from "./models.js";
import { asRect } from "./models.js";
import { fixed } from "./pyfmt.js";

/** Pixels an element may poke out of its container/canvas before it is reported. */
export const TOLERANCE = 1.0;
export const MAX_TRACKS = 30;
export const MAX_REPORTED = 12;
export const SMALL_FRACTION = 0.2;
export const CONTAINERS = new Set(["g", "svg", "a", "switch", "div", "section", "main", "article", "span"]);

export interface Element {
  index: number;
  tag: string;
  label: string;
  svg: boolean;
  parent: number;
}

/** `[index, clientRect, userRect | null, visible]` per rendered element (runtime `measure()`). */
export type GeometryEntry = [number, number[], number[] | null, boolean];

/** Everything captured at one sample time. */
export interface FrameGeometry {
  t: number;
  geometry: GeometryEntry[];
  /** HTML text overflow `[index, dx, dy]`. */
  overflow: [number, number, number][];
}

export interface Description {
  i: number;
  tag: string;
  label: string;
  svg: boolean;
  parent: number;
}

/** Inputs shared by all render checks. */
export class Geometry {
  constructor(
    public elements: Map<number, Element>,
    public times: number[],
    /** Client rect (CSS px) per element per frame; `null` = not rendered/invisible. */
    public client: Map<number, (Rect | null)[]>,
    /** SVG user-space rect (outermost `<svg>`) per element per frame. */
    public user: Map<number, (Rect | null)[]>,
    public canvas: Rect,
    public viewbox: Rect | null,
    public targets: Map<number, string[]>,
    public animations: AnimationTiming[],
    public isSvgDoc: boolean,
    /** `[index, dx, dy]` per frame. */
    public htmlOverflow: [number, number, number][][],
  ) {}

  static build(
    description: Description[],
    snapshots: FrameGeometry[],
    opts: {
      canvas: Rect;
      viewbox: Rect | null;
      targets: Record<string, string[]>;
      animations: AnimationTiming[];
      isSvgDoc: boolean;
    },
  ): Geometry {
    const elements = new Map<number, Element>();
    for (const d of description) {
      elements.set(d.i, { index: d.i, tag: d.tag, label: d.label, svg: d.svg, parent: d.parent });
    }
    const n = snapshots.length;
    const client = new Map<number, (Rect | null)[]>();
    const user = new Map<number, (Rect | null)[]>();
    const slot = (m: Map<number, (Rect | null)[]>, i: number) => {
      let v = m.get(i);
      if (!v) {
        v = new Array<Rect | null>(n).fill(null);
        m.set(i, v);
      }
      return v;
    };
    snapshots.forEach((snap, k) => {
      for (const [index, rect, userRect, visible] of snap.geometry) {
        if (!visible) continue;
        slot(client, index)[k] = asRect(rect);
        if (userRect != null) slot(user, index)[k] = asRect(userRect);
      }
    });
    const targets = new Map<number, string[]>();
    for (const [k, v] of Object.entries(opts.targets)) targets.set(Number(k), v);
    return new Geometry(
      elements,
      snapshots.map((s) => s.t),
      client,
      user,
      opts.canvas,
      opts.viewbox,
      targets,
      opts.animations,
      opts.isSvgDoc,
      snapshots.map((s) => s.overflow),
    );
  }

  ancestors(index: number): number[] {
    const out: number[] = [];
    let parent = this.elements.get(index)?.parent ?? -1;
    while (parent !== -1 && this.elements.has(parent)) {
      out.push(parent);
      parent = this.elements.get(parent)!.parent;
    }
    return out;
  }

  label(index: number): string {
    return this.elements.get(index)?.label ?? `element ${index}`;
  }

  moved(): Set<number> {
    const out = new Set<number>();
    for (const [index, rects] of this.client) {
      const present = rects.filter((r): r is Rect => r !== null);
      if (present.length !== rects.length && present.length) {
        out.add(index); // appears / disappears
        continue;
      }
      if (present.length && present.slice(1).some((r) => differs(present[0], r))) out.add(index);
    }
    return out;
  }
}

function differs(a: Rect, b: Rect, tol = 0.5): boolean {
  return a.some((x, i) => Math.abs(x - b[i]) > tol);
}

/** Drop flagged elements that have a flagged descendant (report the innermost). */
function leaves(geo: Geometry, flagged: Set<number>): Set<number> {
  const covered = new Set<number>();
  for (const i of flagged) for (const a of geo.ancestors(i)) covered.add(a);
  return new Set([...flagged].filter((i) => !covered.has(i)));
}

function timesAt(geo: Geometry, ks: number[]): number[] {
  return ks.map((k) => geo.times[k]);
}

export function fmtTimes(times: number[]): string {
  if (times.length > 4) {
    return `t=${fixed(times[0], 2)}s..${fixed(times[times.length - 1], 2)}s (${times.length} frames)`;
  }
  return `t=${times.map((t) => `${fixed(t, 2)}s`).join(", ")}`;
}

function finding(code: string, message: string, element: string | null, times: number[] | null): Finding {
  return { severity: "warning", code, message, check: "render", element, times };
}

const byNumber = (a: number, b: number) => a - b;

/** Per-frame boxes of animated elements (declared targets or anything that moved). */
export function tracks(geo: Geometry): ElementTrack[] {
  const moved = geo.moved();
  const targetSet = new Set(geo.targets.keys());
  // A moving group moves all its children: keep the outermost mover. A group whose box
  // only changes because an animated descendant moves is not reported on its own.
  const explained = new Set<number>();
  for (const i of targetSet) for (const a of geo.ancestors(i)) if (!targetSet.has(a)) explained.add(a);
  const movers = new Set([...moved].filter((i) => !explained.has(i)));
  const indices = new Set<number>(targetSet);
  for (const i of movers) if (!geo.ancestors(i).some((a) => movers.has(a))) indices.add(i);
  const out: ElementTrack[] = [];
  for (const index of [...indices].sort(byNumber).slice(0, MAX_TRACKS)) {
    const boxes = geo.user.get(index) ?? geo.client.get(index);
    if (!boxes) continue;
    const kinds = [...(geo.targets.get(index) ?? [])];
    if (moved.has(index)) kinds.push("moved");
    out.push({
      element: geo.label(index),
      animated_by: kinds,
      units: geo.user.has(index) ? "viewBox" : "px",
      boxes,
    });
  }
  return out;
}

/** Elements extending past the viewBox (SVG) or viewport (HTML). */
export function checkOutside(geo: Geometry): Finding[] {
  const [cx, cy, cw, ch] = geo.canvas;
  const hits = new Map<number, number[]>();
  const amounts = new Map<number, Map<string, number>>();
  for (const [index, rects] of geo.client) {
    rects.forEach((rect, k) => {
      if (rect === null) return;
      const [x, y, w, h] = rect;
      const over: [string, number][] = [
        ["left", cx - x],
        ["top", cy - y],
        ["right", x + w - (cx + cw)],
        ["bottom", y + h - (cy + ch)],
      ];
      const worst = over.filter(([, v]) => v > TOLERANCE);
      if (worst.length) {
        (hits.get(index) ?? hits.set(index, []).get(index)!).push(k);
        const agg = amounts.get(index) ?? amounts.set(index, new Map()).get(index)!;
        for (const [side, v] of worst) agg.set(side, Math.max(agg.get(side) ?? 0, v));
      }
    });
  }
  const keep = leaves(geo, new Set(hits.keys()));
  const area = geo.isSvgDoc ? "viewBox" : "viewport";
  const out: Finding[] = [];
  const worstOf = (i: number) => Math.max(...amounts.get(i)!.values());
  // Python sorts a set of small ints (ascending iteration order) by the worst amount.
  const ordered = [...keep].sort(byNumber).sort((a, b) => worstOf(b) - worstOf(a));
  for (const index of ordered.slice(0, MAX_REPORTED)) {
    const ks = hits.get(index)!;
    const sides = [...amounts.get(index)!.entries()].map(([side, v]) => `${fixed(v, 0)}px ${side}`).join(", ");
    const when = ks.length === geo.times.length ? "at every frame" : `at ${fmtTimes(timesAt(geo, ks))}`;
    out.push(
      finding(
        "outside-bounds",
        `${geo.label(index)} extends outside the ${area} ${when} (up to ${sides}).`,
        geo.label(index),
        timesAt(geo, ks),
      ),
    );
  }
  if (ordered.length > MAX_REPORTED) {
    out.push(
      finding(
        "outside-bounds",
        `... and ${ordered.length - MAX_REPORTED} more element(s) outside the ${area}.`,
        null,
        null,
      ),
    );
  }
  return out;
}

/** Small SVG elements sitting on the user-space origin (0,0), e.g. before `begin`. */
export function checkParked(geo: Geometry): Finding[] {
  if (geo.viewbox === null) return [];
  const [, , vw, vh] = geo.viewbox;
  const hits = new Map<number, number[]>();
  for (const [index, rects] of geo.user) {
    const element = geo.elements.get(index);
    if (!element || CONTAINERS.has(element.tag)) continue;
    rects.forEach((rect, k) => {
      if (rect === null) return;
      const [x, y, w, h] = rect;
      const small = w < SMALL_FRACTION * vw && h < SMALL_FRACTION * vh;
      const coversOrigin = x <= TOLERANCE && y <= TOLERANCE && x + w >= 0 && y + h >= 0;
      if (small && coversOrigin) (hits.get(index) ?? hits.set(index, []).get(index)!).push(k);
    });
  }
  return [...leaves(geo, new Set(hits.keys()))].sort(byNumber).map((index) => {
    const times = timesAt(geo, hits.get(index)!);
    return finding(
      "parked-at-origin",
      `${geo.label(index)} sits at the SVG origin (0,0) at ${fmtTimes(times)}; ` +
        "typical cause: <animateMotion> with a positive begin, or a missing x/y/cx/cy.",
      geo.label(index),
      times,
    );
  });
}

const rectArea = (r: Rect) => r[2] * r[3];

function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]);
  return Math.max(0, w) * Math.max(0, h);
}

function excess(inner: Rect, outer: Rect): number {
  return Math.max(
    outer[0] - inner[0],
    outer[1] - inner[1],
    inner[0] + inner[2] - (outer[0] + outer[2]),
    inner[1] + inner[3] - (outer[1] + outer[3]),
  );
}

/** Smallest rect painted before `text` that covers at least 30% of it. */
function container(geo: Geometry, text: number, box: Rect, rects: number[], k: number): number | null {
  let best: number | null = null;
  let bestArea = Infinity;
  for (const index of rects) {
    if (index > text || !geo.client.has(index)) continue;
    const rect = geo.client.get(index)![k];
    if (rect === null || rectArea(box) === 0) continue;
    if (overlap(box, rect) / rectArea(box) >= 0.3 && rectArea(rect) < bestArea) {
      best = index;
      bestArea = rectArea(rect);
    }
  }
  return best;
}

/** SVG `<text>` poking out of the `<rect>` painted under it; HTML text overflow. */
export function checkTextOverflow(geo: Geometry): Finding[] {
  const hits = new Map<string, number[]>();
  const amounts = new Map<string, number>();
  const rects = [...geo.elements.values()].filter((el) => el.tag === "rect").map((el) => el.index);
  for (const [index, el] of geo.elements) {
    if (el.tag !== "text" || !geo.client.has(index)) continue;
    geo.client.get(index)!.forEach((textBox, k) => {
      if (textBox === null) return;
      const box = container(geo, index, textBox, rects, k);
      if (box === null) return;
      const containerBox = geo.client.get(box)![k];
      if (containerBox === null) return;
      const ex = excess(textBox, containerBox);
      if (ex > TOLERANCE) {
        const key = `${index},${box}`;
        (hits.get(key) ?? hits.set(key, []).get(key)!).push(k);
        amounts.set(key, Math.max(amounts.get(key) ?? 0, ex));
      }
    });
  }
  const keyed = [...hits.entries()]
    .map(([key, ks]) => ({ key, ks, pair: key.split(",").map(Number) as [number, number] }))
    .sort((a, b) => a.pair[0] - b.pair[0] || a.pair[1] - b.pair[1]);
  const out: Finding[] = keyed.map(({ key, ks, pair: [text, box] }) =>
    finding(
      "text-overflow",
      `${geo.label(text)} overflows its container ${geo.label(box)} by up to ` +
        `${fixed(amounts.get(key)!, 0)}px at ${fmtTimes(timesAt(geo, ks))}.`,
      geo.label(text),
      timesAt(geo, ks),
    ),
  );
  const htmlHits = new Map<number, number[]>();
  const htmlAmount = new Map<number, [number, number]>();
  geo.htmlOverflow.forEach((items, k) => {
    for (const [index, dx, dy] of items) {
      (htmlHits.get(index) ?? htmlHits.set(index, []).get(index)!).push(k);
      const [ox, oy] = htmlAmount.get(index) ?? [0, 0];
      htmlAmount.set(index, [Math.max(ox, dx), Math.max(oy, dy)]);
    }
  });
  for (const index of [...htmlHits.keys()].sort(byNumber)) {
    const ks = htmlHits.get(index)!;
    const [dx, dy] = htmlAmount.get(index)!;
    out.push(
      finding(
        "text-overflow",
        `${geo.label(index)} content is larger than its box (${fixed(dx, 0)}px wider, ` +
          `${fixed(dy, 0)}px taller) at ${fmtTimes(timesAt(geo, ks))}.`,
        geo.label(index),
        timesAt(geo, ks),
      ),
    );
  }
  return out;
}

/** CSS transform animations on SVG elements without `transform-box: fill-box`. */
export function checkTransformBox(geo: Geometry): Finding[] {
  const out: Finding[] = [];
  const seen = new Set<string>();
  for (const anim of geo.animations) {
    if (anim.transform_box !== "view-box" || !anim.target || seen.has(anim.target)) continue;
    seen.add(anim.target);
    out.push(
      finding(
        "svg-transform-box",
        `CSS animation '${anim.name}' on ${anim.target} animates transform with ` +
          "transform-box: view-box (the SVG default), so it rotates/scales around the " +
          "SVG origin, not the element. Add transform-box: fill-box; " +
          "transform-origin: center.",
        anim.target,
        null,
      ),
    );
  }
  return out;
}

/** Render checks run on every inspection, in order. Append to add a check. */
export const CHECKS: ((geo: Geometry) => Finding[])[] = [
  checkParked,
  checkOutside,
  checkTextOverflow,
  checkTransformBox,
];

export function runChecks(geo: Geometry): Finding[] {
  const findings = CHECKS.flatMap((check) => check(geo));
  // An element parked at (0,0) usually pokes out of the top-left corner too: report once.
  const parked = new Set<string>();
  for (const f of findings) {
    if (f.code === "parked-at-origin") for (const t of f.times ?? []) parked.add(`${f.element}@${t}`);
  }
  return findings.filter(
    (f) =>
      !(
        f.code === "outside-bounds" &&
        f.times &&
        f.times.length &&
        f.times.every((t) => parked.has(`${f.element}@${t}`))
      ),
  );
}
