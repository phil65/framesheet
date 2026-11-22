/**
 * Video and animated-image inputs (port of video.py): exact seeks in Chromium, dense
 * samples, pacing checks (static stretches, black/blank frames, cuts, mark overlaps), and
 * the sheet with marks and a timeline.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve as resolvePath } from "node:path";
import type { Browser, Route } from "playwright-core";
import { contactSheet, heatmap, type Renderer } from "./compose.js";
import { VIDEO_JS } from "./generated/assets.js";
import {
  activeLabels,
  bandText,
  hasBand,
  type Issue,
  tileOps,
  tileWindows,
  timelineOps,
} from "./marks.js";
import { isAnimatedImage, MIME_TYPES, probe as probeMedia, type Probe } from "./media.js";
import type {
  ActivitySample,
  DurationInfo,
  Finding,
  FrameMetrics,
  ImageBuffers,
  ImagePaths,
  Marks,
  Rect,
  Report,
  VideoInfo,
  VideoTile,
} from "./models.js";
import { asRect } from "./models.js";
import { decode, diffStats, type Frame, frameStats, MotionAccumulator, sharpness, toCss } from "./pixels.js";
import { fixed, g, pct, pyRound } from "./pyfmt.js";
import { DEFAULT_HTML_SIZE, type Source, VIDEO_ORIGIN, VIDEO_PAGE } from "./sources.js";

/** A sample step changing fewer than 0.05% of pixels counts as "no visible change". */
export const STATIC_RATIO = 0.0005;
/** A step changing at least 40% of pixels ... */
export const CUT_RATIO = 0.4;
/** ... while both neighbouring steps change at most a quarter of that is an abrupt cut. */
export const CUT_NEIGHBOUR = 0.25;
/** Dense samples are at most this far apart (seconds), up to MAX_SAMPLES. */
export const SAMPLE_STEP = 0.25;
export const MAX_SAMPLES = 240;
export const MAX_TILES = 100;
const MAX_LISTED = 8;
export const DEFAULT_STATIC_STRETCH = 2.0;

export type TimesSpec = number[] | "marks";

export interface VideoOptions {
  frames?: number;
  every?: number;
  times?: TimesSpec;
  start?: number;
  end?: number;
  marks?: Marks | null;
}

/** Range and tile times: `[start, end, times, mode]`. */
export function planTimes(total: number, o: VideoOptions = {}): [number, number, number[], string] {
  const a = o.start ?? 0;
  let b = o.end ?? total;
  if (a < 0 || b <= a || b > total + 1e-6) {
    throw new RangeError(`Invalid range ${g(a)}-${g(b)}s (the media is ${g(total)}s long)`);
  }
  b = Math.min(b, total);
  let ts: number[];
  let mode: string;
  if (o.times === "marks") {
    const marks = o.marks;
    if (!marks) throw new RangeError("times='marks' needs marks");
    ts = [
      ...marks.points.map((p) => p.t),
      ...marks.regions.map((r) => (r.start + r.end) / 2),
      ...marks.spans.map((s) => (s.start + s.end) / 2),
    ].filter((t) => a <= t && t <= b);
    if (!ts.length) throw new RangeError("No mark falls inside the inspected range");
    mode = "times from marks";
  } else if (o.times !== undefined) {
    ts = o.times.map(Number);
    if (!ts.length) throw new RangeError("times must not be empty");
    const bad = ts.filter((t) => !(a <= t && t <= b));
    if (bad.length) throw new RangeError(`Times outside the range ${g(a)}-${g(b)}s: ${bad.map(g).join(", ")}`);
    mode = "--times";
  } else if (o.every !== undefined) {
    const every = o.every;
    if (!(every > 0)) throw new RangeError("every must be positive");
    const n = Math.floor((b - a) / every + 1e-9) + 1;
    if (n > MAX_TILES) throw new RangeError(`every=${g(every)}s gives ${n} tiles (max ${MAX_TILES})`);
    ts = Array.from({ length: n }, (_, k) => a + k * every);
    if (b - ts[ts.length - 1] > 1e-6) ts.push(b);
    mode = `every ${g(every)}s`;
  } else {
    const frames = o.frames ?? 12;
    if (!(frames >= 2 && frames <= MAX_TILES)) throw new RangeError("frames must be between 2 and 100");
    ts = Array.from({ length: frames }, (_, i) => a + ((b - a) * i) / (frames - 1));
    ts[ts.length - 1] = b;
    mode = "evenly spaced";
  }
  const out = [...new Set(ts.map((t) => pyRound(t, 4)))].sort((x, y) => x - y);
  if (out.length > MAX_TILES) throw new RangeError(`${out.length} tiles (max ${MAX_TILES})`);
  return [a, b, out, mode];
}

/** Evenly spaced pacing samples over `[start, end]` (both ends included). */
export function denseTimes(start: number, end: number, heatFrames: number): number[] {
  if (heatFrames <= 0) return [];
  const count = Math.min(MAX_SAMPLES, Math.max(heatFrames, Math.ceil((end - start) / SAMPLE_STEP)));
  return Array.from({ length: count + 1 }, (_, k) => pyRound(start + ((end - start) * k) / count, 4));
}

/** Maximal runs of sample steps without visible change lasting > `threshold` s. */
export function staticStretches(samples: ActivitySample[], threshold: number): [number, number][] {
  const out: [number, number][] = [];
  let runStart: number | null = null;
  for (let k = 1; k <= samples.length; k++) {
    const still = k < samples.length && samples[k].changed_ratio < STATIC_RATIO;
    if (still && runStart === null) runStart = k - 1;
    else if (!still && runStart !== null) {
      const a = samples[runStart].t;
      const b = samples[k - 1].t;
      if (b - a > threshold) out.push([a, b]);
      runStart = null;
    }
  }
  return out;
}

/** Sample times where one step changes >= CUT_RATIO and its neighbours little. */
export function abruptCuts(samples: ActivitySample[]): number[] {
  const out: number[] = [];
  const n = samples.length;
  for (let k = 1; k < n; k++) {
    const r = samples[k].changed_ratio;
    const prev = k >= 2 ? samples[k - 1].changed_ratio : 0;
    const next = k + 1 < n ? samples[k + 1].changed_ratio : 0;
    if (r >= CUT_RATIO && prev <= r * CUT_NEIGHBOUR && next <= r * CUT_NEIGHBOUR) out.push(samples[k].t);
  }
  return out;
}

function runs(times: number[], flags: Map<number, boolean>): [number, number][] {
  const out: [number, number][] = [];
  let current: number[] = [];
  for (const t of times) {
    if (flags.get(t)) current.push(t);
    else if (current.length) {
      out.push([current[0], current[current.length - 1]]);
      current = [];
    }
  }
  if (current.length) out.push([current[0], current[current.length - 1]]);
  return out;
}

function listed(times: number[]): string {
  const text = times
    .slice(0, MAX_LISTED)
    .map((t) => `${fixed(t, 2)}s`)
    .join(", ");
  return text + (times.length > MAX_LISTED ? ` (+${times.length - MAX_LISTED} more)` : "");
}

const render = (severity: Finding["severity"], code: string, message: string, times: number[] | null): Finding => ({
  severity,
  code,
  message,
  check: "render",
  element: null,
  times,
});

/** Span boxes (captions) covering `target` region boxes while both are active. */
export function markOverlaps(marks: Marks, start: number, end: number): Finding[] {
  const out: Finding[] = [];
  const nrm = (x: number, y: number): [number, number] => (marks.frame ? [x / marks.frame.width, y / marks.frame.height] : [x, y]);
  for (const s of marks.spans) {
    for (const r of marks.regions) {
      if (s.x === null || r.x === null || r.kind !== "target") continue;
      const a = Math.max(s.start, r.start, start);
      const b = Math.min(s.end, r.end, end);
      if (a > b) continue;
      const [sx, sy] = nrm(s.x, s.y!);
      const [sx2, sy2] = nrm(s.x + s.w!, s.y! + s.h!);
      const [rx, ry] = nrm(r.x, r.y!);
      const [rx2, ry2] = nrm(r.x + r.w!, r.y! + r.h!);
      const iw = Math.min(sx2, rx2) - Math.max(sx, rx);
      const ih = Math.min(sy2, ry2) - Math.max(sy, ry);
      if (iw <= 0 || ih <= 0) continue;
      const share = (iw * ih) / ((rx2 - rx) * (ry2 - ry));
      out.push(
        render(
          "warning",
          "video-mark-overlap",
          `Span "${s.label}" covers target "${r.label || "target"}" for t=${fixed(a, 2)}-${fixed(b, 2)}s (${pct(share, 0)} of the target box).`,
          [pyRound(a, 4), pyRound(b, 4)],
        ),
      );
    }
  }
  return out;
}

/** Findings plus timeline issues. */
export function videoFindings(
  samples: ActivitySample[],
  stats: Map<number, [boolean, boolean]>,
  threshold: number,
  marks: Marks | null,
  start: number,
  end: number,
): [Finding[], Issue[]] {
  const findings: Finding[] = [];
  let issues: Issue[] = [];
  for (const [a, b] of staticStretches(samples, threshold)) {
    findings.push(
      render(
        "warning",
        "video-static-stretch",
        `No visible change for ${fixed(b - a, 2)}s (t=${fixed(a, 2)}-${fixed(b, 2)}s; under ${pct(STATIC_RATIO, 2)} of pixels per sample): dead time?`,
        [a, b],
      ),
    );
    issues.push({ kind: "static", start: a, end: b });
  }
  const times = samples.map((s) => s.t);
  const kinds: ["black" | "blank", number, string][] = [
    ["black", 0, "black"],
    ["blank", 1, "one flat colour (blank)"],
  ];
  for (const [kind, index, what] of kinds) {
    const flags = new Map(times.map((t) => [t, stats.get(t)![index]]));
    const hits = times.filter((t) => flags.get(t));
    if (!hits.length) continue;
    findings.push(render("warning", `video-${kind}-frames`, `${hits.length} sampled frame(s) are ${what}: t=${listed(hits)}.`, hits));
    issues.push(...runs(times, flags).map(([a, b]) => ({ kind, start: a, end: b })));
  }
  const cuts = abruptCuts(samples);
  if (cuts.length) {
    findings.push(
      render(
        "info",
        "video-abrupt-cut",
        `Abrupt change (>= ${pct(CUT_RATIO, 0)} of pixels in one sample step, quiet neighbours) at t=${listed(cuts)}: a hard cut or a jump.`,
        cuts,
      ),
    );
    issues.push(...cuts.map((t) => ({ kind: "cut" as const, start: t, end: t })));
  }
  if (marks) findings.push(...markOverlaps(marks, start, end));
  // Python: sort by (start, kind), stable.
  issues = issues
    .map((it, i) => [it, i] as const)
    .sort((x, y) => x[0].start - y[0].start || (x[0].kind < y[0].kind ? -1 : x[0].kind > y[0].kind ? 1 : 0) || x[1] - y[1])
    .map(([it]) => it);
  return [findings, issues];
}

export function decodeHint(label: string, probe: Probe, error: string): string {
  return (
    `Chromium could not decode ${label} (${probe.container}/${probe.codec || "unknown codec"}): ${error}. ` +
    "Playwright's Chromium may lack proprietary codecs (H.264/HEVC): re-encode to " +
    "WebM/VP9 (ffmpeg -i in.mp4 -c:v libvpx-vp9 -crf 32 -b:v 0 out.webm) or use an " +
    "installed Chrome (launchOptions: { channel: 'chrome' })."
  );
}

function tileLabel(t: number, i: number, count: number, start: number, end: number): string {
  const label = `t=${fixed(t, 2)}s`;
  if (i === 0 && t === start) return `${label}  start`;
  if (i === count - 1 && t === end) return `${label}  end`;
  return label;
}

/** Route handler serving `body` with HTTP range support (media elements seek by range). */
function serve(body: Buffer, contentType: string) {
  return (route: Route) => {
    const total = body.length;
    const headers: Record<string, string> = { "Content-Type": contentType, "Accept-Ranges": "bytes" };
    const m = /^bytes=(\d*)-(\d*)$/.exec(route.request().headers().range ?? "");
    if (!m || total === 0) return route.fulfill({ status: 200, headers, body });
    const first = Number(m[1] || 0);
    const last = Math.min(m[2] ? Number(m[2]) : total - 1, total - 1);
    if (first >= total || last < first) return route.fulfill({ status: 416, headers: { "Content-Range": `bytes */${total}` } });
    headers["Content-Range"] = `bytes ${first}-${last}/${total}`;
    return route.fulfill({ status: 206, headers, body: body.subarray(first, last + 1) });
  };
}

export interface VideoPipelineOptions extends VideoOptions {
  duration?: number;
  size?: [number, number];
  scale?: number;
  at?: number;
  out?: string;
  tile?: number;
  columns?: number;
  keepFrames?: boolean;
  heatFrames?: number;
  timeout?: number;
  staticStretch?: number;
}

type Built = { report: Report; images: ImageBuffers; paths: ImagePaths | null };

export async function inspectVideo(
  src: Source,
  browser: Browser,
  renderer: Renderer,
  o: VideoPipelineOptions,
  autoScale: (size: [number, number]) => number,
): Promise<Built> {
  const data = src.media!;
  const probe = probeMedia(data, src.container ?? null);
  let viewport: [number, number] = o.size ?? (probe.width && probe.height ? [probe.width, probe.height] : DEFAULT_HTML_SIZE);
  const dsf = o.scale ?? (o.size ? 1 : autoScale(viewport));
  const mime = MIME_TYPES[probe.container];
  const decoder = isAnimatedImage(probe) ? "image-decoder" : "video";
  const marks = o.marks ?? null;
  const threshold = o.staticStretch ?? DEFAULT_STATIC_STRETCH;
  const heatFrames = o.heatFrames ?? 48;
  const context = await browser.newContext({
    viewport: { width: viewport[0], height: viewport[1] },
    deviceScaleFactor: dsf,
    colorScheme: "light",
    reducedMotion: "no-preference",
    locale: "en-US",
    timezoneId: "UTC",
  });
  try {
    await context.route(`${VIDEO_ORIGIN}/video.html`, serve(Buffer.from(VIDEO_PAGE), "text/html; charset=utf-8"));
    await context.route(`${VIDEO_ORIGIN}/media`, serve(data, mime));
    const page = await context.newPage();
    page.setDefaultTimeout(o.timeout ?? 30_000);
    const consoleErrors: string[] = [];
    page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(`console.${msg.type()}: ${msg.text()}`);
    });
    await page.goto(src.url, { waitUntil: "load" });
    await page.evaluate(VIDEO_JS);
    type Loaded = { width: number; height: number; duration: number | null; fps: number | null; frame_count: number | null };
    let loaded: Loaded;
    try {
      loaded = await page.evaluate(
        ([s, d, t]) => (window as unknown as { __framesheetVideo: { load(s: string, d: string, t: string): Promise<Loaded> } }).__framesheetVideo.load(s, d, t),
        ["/media", decoder, mime] as [string, string, string],
      );
    } catch (err) {
      const first = String((err as Error).message ?? err).split("\n")[0];
      throw new Error(decodeHint(src.label, probe, first));
    }
    const width = Number(loaded.width);
    const height = Number(loaded.height);
    if (!o.size && (width !== viewport[0] || height !== viewport[1])) {
      viewport = [width, height];
      await page.setViewportSize({ width, height });
    }
    const mediaDuration = loaded.duration === null ? null : pyRound(Number(loaded.duration), 4);
    const total = o.duration || mediaDuration;
    if (!total) throw new RangeError(`Unknown media duration of ${src.label}: pass duration`);
    const [a, b, tileTimes, mode] = planTimes(total, o);
    const fullAt = o.at === undefined ? a : pyRound(o.at, 4);
    if (!(fullAt >= 0 && fullAt <= total)) throw new RangeError(`at ${g(fullAt)}s is outside the media (0-${g(total)}s)`);
    const content = asRect(await page.evaluate("window.__framesheetVideo.contentBox()") as number[]);
    const wanted = new Set([...tileTimes, fullAt]);
    const everything = [...new Set([...wanted, ...denseTimes(a, b, heatFrames)])].sort((x, y) => x - y);
    const kept = new Map<number, { png: Buffer; frame: Frame }>();
    const mediaTimes = new Map<number, number | null>();
    const samples: ActivitySample[] = [];
    const stats = new Map<number, [boolean, boolean]>();
    const motion = new MotionAccumulator();
    let prev: Frame | null = null;
    for (const t of everything) {
      const mt = (await page.evaluate(
        (time) => (window as unknown as { __framesheetVideo: { seek(t: number): Promise<number | null> } }).__framesheetVideo.seek(time),
        t,
      )) as number | null;
      mediaTimes.set(t, mt === null ? null : pyRound(Number(mt), 4));
      const png = await page.screenshot({ type: "png", caret: "hide", animations: "allow", scale: "device" });
      const frame = decode(png);
      if (wanted.has(t)) kept.set(t, { png, frame });
      if (a <= t && t <= b) {
        const ratio = prev ? diffStats(prev, frame)[0] : 0;
        samples.push({ t, changed_ratio: pyRound(ratio, 5) });
        stats.set(t, frameStats(frame));
        motion.add(frame);
        prev = frame;
      }
    }
    const tileFrames = tileTimes.map((t) => kept.get(t)!);
    const metrics: FrameMetrics[] = [{ index: 0, t: tileTimes[0], changed_ratio: 0, changed_box: null, path: null }];
    for (let i = 1; i < tileFrames.length; i++) {
      const [ratio, box] = diffStats(tileFrames[i - 1].frame, tileFrames[i].frame);
      metrics.push({ index: i, t: tileTimes[i], changed_ratio: pyRound(ratio, 5), changed_box: toCss(box, dsf), path: null });
    }
    const moving = samples.some((s) => s.changed_ratio > 0);
    const info: DurationInfo = {
      seconds: total,
      method: o.duration ? "override" : "media",
      looping: false,
      detail: o.duration
        ? `--duration ${g(o.duration)}s${mediaDuration ? ` (media reports ${g(mediaDuration)}s)` : ""}`
        : `media duration ${g(total)}s`,
      animations: [],
    };
    const [findings, issues] = videoFindings(samples, stats, threshold, marks, a, b);
    if (!moving) findings.push(render("info", "no-motion", "No animation found and no pixel changed: static.", null));
    for (const msg of consoleErrors.slice(0, 5)) findings.push(render("warning", "console-error", msg, null));
    const order = { error: 0, warning: 1, info: 2 };
    findings.sort((x, y) => order[x.severity] - order[y.severity]);

    const windows = tileWindows(tileTimes, a, b);
    const n = tileTimes.length;
    const tiles: VideoTile[] = tileTimes.map((t, i) => ({
      index: i,
      t,
      media_time: mediaTimes.get(t) ?? null,
      black: stats.get(t)![0],
      blank: stats.get(t)![1],
      duplicate: i > 0 && metrics[i].changed_ratio < STATIC_RATIO,
      sharpness: sharpness(tileFrames[i].frame),
      marks: marks ? activeLabels(marks, t, windows[i], i === n - 1) : [],
    }));
    const video: VideoInfo = {
      container: probe.container,
      codec: probe.codec,
      decoder,
      width,
      height,
      media_duration: mediaDuration,
      fps: loaded.fps ?? probe.fps,
      frame_count: loaded.frame_count ?? probe.frameCount,
      start: a,
      end: b,
      static_threshold: threshold,
      samples,
      tiles,
    };
    const title = basename(src.label);
    let facts = `${video.container}/${video.codec || "?"} ${width}x${height}`;
    if (video.fps) facts += ` ${g(video.fps)} fps`;
    const labels = tileTimes.map((t, i) => tileLabel(t, i, n, a, b));
    const highlight = [0, n - 1].filter((i, k, arr) => arr.indexOf(i) === k && (labels[i].endsWith("start") || labels[i].endsWith("end")));
    const activity = samples.map((s) => [s.t, s.changed_ratio] as [number, number]);
    const sheet = await contactSheet(
      renderer,
      tileFrames.map((f) => ({ png: f.png, width: f.frame.width, height: f.frame.height })),
      labels,
      {
        title,
        subtitle: `${n} tiles over ${g(a)}-${g(b)}s (${mode}); ${facts}`,
        tile: o.tile,
        columns: o.columns,
        highlight,
        bands: marks && hasBand(marks) ? tileTimes.map((t) => bandText(marks, t)) : null,
        overlay: marks
          ? (i, thumb) => tileOps(marks, tileTimes[i], windows[i], i === n - 1, { size: thumb, viewport, content })
          : null,
        footer: (w) => timelineOps(w, a, b, tileTimes, { marks, activity, issues }),
      },
    );
    const heat = await heatmap(renderer, motion.first!, motion.acc!, {
      title: `${title}: motion heatmap`,
      subtitle: `pixels that change across ${motion.count} frames over ${g(a)}-${g(b)}s; background = t=${g(a)}s, dimmed`,
      boxes: motion.box ? [motion.box] : [],
    });
    const images: ImageBuffers = { full: kept.get(fullAt)!.png, sheet, heatmap: heat };
    if (o.keepFrames) images.frames = tileFrames.map((f) => f.png);
    const out = o.out ? resolvePath(o.out) : null;
    const paths: ImagePaths = out
      ? { full: join(out, "full.png"), sheet: join(out, "sheet.png"), heatmap: join(out, "heatmap.png"), report: join(out, "report.json") }
      : { full: "full.png", sheet: "sheet.png", heatmap: "heatmap.png", report: "report.json" };
    if (o.keepFrames) for (const m of metrics) m.path = join(out ?? "", "frames", `frame_${String(m.index).padStart(3, "0")}.png`);
    const report: Report = {
      source: src.label,
      kind: "video",
      viewport,
      device_scale_factor: dsf,
      canvas: content as Rect,
      duration: info,
      times: tileTimes,
      full_at: fullAt,
      images: paths,
      findings,
      frames: metrics,
      elements: [],
      loop: { checked: false, seamless: null, seam_ratio: null, step_ratio: null, seam_box: null, detail: "not checked for video input" },
      console_errors: consoleErrors,
      video,
      marks,
    };
    if (out) {
      mkdirSync(out, { recursive: true });
      writeFileSync(paths.full, images.full);
      writeFileSync(paths.sheet, images.sheet);
      writeFileSync(paths.heatmap, images.heatmap);
      if (images.frames) {
        mkdirSync(join(out, "frames"), { recursive: true });
        images.frames.forEach((png, i) => writeFileSync(join(out, "frames", `frame_${String(i).padStart(3, "0")}.png`), png));
      }
      writeFileSync(paths.report, `${JSON.stringify(report, null, 2)}\n`);
    }
    return { report, images, paths: out ? paths : null };
  } finally {
    await context.close().catch(() => undefined);
  }
}
