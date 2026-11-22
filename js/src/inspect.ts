/**
 * The inspection pipeline (port of core.py): load, detect duration, sample, check,
 * compose. `inspect()` renders a file/markup/URL in its own browser context;
 * `inspectPage()` inspects a page (or one component) you already have open.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import type { Browser, BrowserContext, ElementHandle, LaunchOptions, Locator, Page } from "playwright-core";
import { Geometry, runChecks, tracks } from "./analysis.js";
import { staticFindings as runStaticChecks, parseSource } from "./checks.js";
import { contactSheet, heatmap, Renderer } from "./compose.js";
import { type Clip, Driver, type Snapshot } from "./driver.js";
import type {
  ColorScheme,
  DurationInfo,
  Finding,
  FrameMetrics,
  ImageBuffers,
  ImagePaths,
  LoopInfo,
  Marks,
  Rect,
  Report,
  Severity,
  SourceKind,
} from "./models.js";
import { asRect } from "./models.js";
import { decode, diffStats, type Frame, MotionAccumulator, toCss } from "./pixels.js";
import { fixed, g, pct, pyRound } from "./pyfmt.js";
import { defaultSize, resolveSource, type Source, VIRTUAL_ORIGIN } from "./sources.js";
import { detectDuration, epsilon, parseTimings, sampleTimes } from "./timing.js";
import { inspectVideo, type TimesSpec } from "./video.js";
import { loadMarks } from "./marks.js";

/** A seam changing fewer than 0.2% of pixels always counts as seamless. */
export const SEAM_MIN_RATIO = 0.002;
/** A seam is a jump if it changes this many times more pixels than one normal step. */
export const SEAM_STEP_FACTOR = 3;
export const MIN_AUTO_SIDE = 400;
export const MAX_CONSOLE_ERRORS = 5;
/** Virtual clock origin (same as Python): 2025-01-01T00:00:00Z. */
export const EPOCH = Date.UTC(2025, 0, 1);
/**
 * Chromium flags framesheet launches with. Pass them to your own browser
 * (`launchOptions: { args: LAUNCH_ARGS }`) for byte-stable frames.
 */
export const LAUNCH_ARGS = [
  // Compositor-thread animations race with pause(): keep them on the main thread.
  "--disable-threaded-animation",
  "--hide-scrollbars",
  "--force-color-profile=srgb",
  "--disable-lcd-text",
];
export const INSTALL_HINT =
  "Chromium for Playwright is not installed. Run `npx playwright install chromium` " +
  "(on a bare Linux host: `npx playwright install --with-deps chromium`).";

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

export class BrowserNotInstalledError extends Error {
  constructor(cause?: unknown) {
    super(INSTALL_HINT, { cause });
    this.name = "BrowserNotInstalledError";
  }
}

/** Options shared by {@link inspect} and {@link inspectPage}. */
export interface SampleOptions {
  /** Number of contact-sheet tiles (2-100), spread over one cycle. Default 12. */
  frames?: number;
  /** Cycle length in seconds; detected from SMIL/CSS/Web Animations if omitted. */
  duration?: number;
  /** Time in seconds of the full-resolution frame `full`. Default 0. */
  at?: number;
  /** Write `full.png`, `sheet.png`, `heatmap.png`, `report.json` here (default: nothing written). */
  out?: string;
  /** Longest side of a contact-sheet tile in px (default: fit 1568 px width). */
  tile?: number;
  /** Contact-sheet columns (default: roughly 4:3 sheet). */
  columns?: number;
  /** Also return (and write to `frames/`) every contact-sheet frame. */
  keepFrames?: boolean;
  /** Extra evenly spaced frames (pixels only) for a continuous heatmap trail. Default 48. */
  heatFrames?: number;
  /** Timeout for navigation and page scripts in ms. Default 30000. */
  timeout?: number;
}

export interface InspectOptions extends SampleOptions {
  /** Viewport `[width, height]` in CSS px (default: SVG size/viewBox, or 1280x720). */
  size?: [number, number];
  /** Device scale factor (default 1; tiny SVGs without `size` get more). */
  scale?: number;
  /** `prefers-color-scheme`. Default `light`. */
  colorScheme?: ColorScheme;
  /** Reuse a browser (a new context is created and closed). Default: launch Chromium. */
  browser?: Browser;
  /** Passed to `chromium.launch()` when no `browser` is given (args are added to LAUNCH_ARGS). */
  launchOptions?: LaunchOptions;
  /**
   * Abort every HTTP(S) request except the input itself (`data:`/`blob:` URLs still work)
   * and close every WebSocket. Recommended for untrusted markup (e.g. agent output in a
   * server). Default false.
   */
  blockNetwork?: boolean;
  /** Videos: one tile every this many seconds (instead of `frames`). */
  every?: number;
  /** Videos: explicit tile times (s), or `"marks"`: each point's t, each region's/span's midpoint. */
  times?: TimesSpec;
  /** Videos: start of the inspected range (s). Default 0. */
  start?: number;
  /** Videos: end of the inspected range (s). Default: the media duration. */
  end?: number;
  /** Videos: marks to draw (path to marks.json, JSON string or object; see marks.schema.json). */
  marks?: string | Marks | Record<string, unknown>;
  /** Videos: seconds without visible change reported as `video-static-stretch`. Default 2. */
  staticStretch?: number;
}

export interface InspectPageOptions extends SampleOptions {
  /** Inspect only this element (a component); default: the whole page/viewport. */
  locator?: Locator;
  /** Header title of the sheet/heatmap (default: locator or URL path; keep stable for snapshots). */
  title?: string;
  /**
   * Whether Playwright's fake clock drives JS time. Default: auto (true if `prepare(page)`
   * ran before navigation). Without it, SMIL/CSS/Web Animations are still frame-accurate,
   * but rAF/timer-driven motion keeps running in real time.
   */
  clock?: boolean;
  /**
   * Called after time is frozen and before t=0 is captured, e.g. `() => button.click()`
   * to start an "open" animation from its first frame.
   */
  trigger?: () => Promise<unknown>;
  /** Extra space (CSS px) around the locator's box in the images. Default 0. */
  padding?: number;
  /** Run static source checks on the locator's/page's serialised markup. Default false. */
  staticChecks?: boolean;
}

/** Everything framesheet found out about one input. */
export class Inspection {
  constructor(
    /** The report (same schema as the Python package's report.json). */
    readonly report: Report,
    /** PNG bytes. */
    readonly images: ImageBuffers,
    /** Written files (only with `out`). */
    readonly files: ImagePaths | null,
  ) {}

  get findings(): Finding[] {
    return this.report.findings;
  }

  get errors(): Finding[] {
    return this.report.findings.filter((f) => f.severity === "error");
  }

  get warnings(): Finding[] {
    return this.report.findings.filter((f) => f.severity === "warning");
  }

  /** All finding codes, handy for assertions. */
  codes(): Set<string> {
    return new Set(this.report.findings.map((f) => f.code));
  }

  /** Concise multi-line text for humans and agents (what the Python CLI prints). */
  summary(): string {
    return summarize(this.report);
  }

  /** `report.json` content. */
  toJSON(): Report {
    return this.report;
  }
}

/** Concise multi-line text for a report (same format as the Python package). */
export function summarize(r: Report): string {
  const [w, h] = r.viewport;
  const d = r.duration;
  const lines = [
    `framesheet: ${r.source} (${r.kind}, ${w}x${h} @${g(r.device_scale_factor)}x)`,
    `duration: ${g(d.seconds)}s ${d.method}: ${d.detail}${d.looping ? " [looping]" : ""}`,
  ];
  const v = r.video;
  if (v) {
    let facts = `${v.container} ${v.codec || "?"} ${v.width}x${v.height}`;
    if (v.fps) facts += ` ${g(v.fps)}fps`;
    if (v.frame_count) facts += `, ${v.frame_count} frames`;
    lines.push(`video: ${facts}; range ${g(v.start)}-${g(v.end)}s, ${v.samples.length} samples`);
  }
  const busiest = r.frames.reduce((a, b) => (b.changed_ratio > a.changed_ratio ? b : a));
  const motion = busiest.changed_ratio
    ? `max change ${pct(busiest.changed_ratio, 1)} at t=${fixed(busiest.t, 2)}s`
    : "no pixel changes";
  lines.push(`frames: ${r.times.length} at t=${fixed(r.times[0], 2)}..${fixed(r.times[r.times.length - 1], 2)}s; ${motion}`);
  if (r.loop.checked) lines.push(`loop: ${r.loop.seamless ? "seamless" : "NOT seamless"} (${r.loop.detail})`);
  else lines.push(`loop: not checked (${r.loop.detail})`);
  const moving = r.elements.slice(0, 8).map((e) => e.element);
  if (moving.length) {
    const more = r.elements.length > 8 ? ` (+${r.elements.length - 8} more)` : "";
    lines.push(`animated elements: ${moving.join(", ")}${more}`);
  }
  const count = (s: Severity) => r.findings.filter((f) => f.severity === s).length;
  lines.push(`findings: ${count("error")} error(s), ${count("warning")} warning(s), ${count("info")} info`);
  const tags: Record<Severity, string> = { error: "ERROR", warning: "WARN ", info: "INFO " };
  for (const f of r.findings) lines.push(`  ${tags[f.severity]} [${f.check}] ${f.code}: ${f.message}`);
  lines.push(
    "images:",
    `  full     ${r.images.full}  (t=${g(r.full_at)}s: layout, text, margins)`,
    `  sheet    ${r.images.sheet}  ${v ? "(tiles over the range + timeline)" : "(motion over one cycle)"}`,
    `  heatmap  ${r.images.heatmap}  (what moves at all)`,
    `  report   ${r.images.report}`,
  );
  return lines.join("\n");
}

function validate(opts: SampleOptions): void {
  const frames = opts.frames ?? 12;
  if (!(frames >= 2 && frames <= 100) || !Number.isInteger(frames)) {
    throw new RangeError("frames must be an integer between 2 and 100");
  }
  if (opts.duration != null && !(opts.duration > 0)) throw new RangeError("duration must be positive");
  if (opts.at != null && !(opts.at >= 0)) throw new RangeError("at must be >= 0");
  if (opts.heatFrames != null && !(opts.heatFrames >= 0)) throw new RangeError("heatFrames must be >= 0");
}

/** Tiny SVGs (icons) get a higher device scale factor so frames stay legible. */
function autoScale(size: [number, number]): number {
  const longest = Math.max(...size);
  return longest < MIN_AUTO_SIDE ? Math.min(8, Math.ceil(MIN_AUTO_SIDE / longest)) : 1;
}

function isMissingBrowser(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err);
  return msg.includes("Executable doesn't exist") || msg.includes("playwright install");
}

async function launch(options?: LaunchOptions): Promise<Browser> {
  const { chromium } = await import("playwright-core");
  try {
    return await chromium.launch({ ...options, args: [...LAUNCH_ARGS, ...(options?.args ?? [])] });
  } catch (err) {
    if (isMissingBrowser(err)) throw new BrowserNotInstalledError(err);
    throw err;
  }
}

function listenForErrors(page: Page, sink: string[]): () => void {
  const onPageError = (err: Error) => sink.push(`pageerror: ${err.message}`);
  const onConsole = (msg: import("playwright-core").ConsoleMessage) => {
    if (msg.type() === "error") sink.push(`console.${msg.type()}: ${msg.text()}`);
  };
  page.on("pageerror", onPageError);
  page.on("console", onConsole);
  return () => {
    page.off("pageerror", onPageError);
    page.off("console", onConsole);
  };
}

function titleOf(label: string): string {
  if (label === "-" || label === "<snippet>") return "stdin";
  const parts = label.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? label;
}

/**
 * Render an animated SVG/HTML at evenly spaced virtual times and check it.
 *
 * @param source Path to an `.svg`/`.html` file, an `http(s)://` URL, or a markup string
 *   starting with `<`.
 */
export async function inspect(source: string, options: InspectOptions = {}): Promise<Inspection> {
  validate(options);
  const src = await resolveSource(source);
  const videoOnly = (["every", "times", "start", "end", "marks"] as const).filter((k) => options[k] !== undefined);
  if (src.kind !== "video" && videoOnly.length) throw new RangeError(`${videoOnly.join(", ")}: only for video inputs`);
  if (options.staticStretch !== undefined && !(options.staticStretch > 0)) throw new RangeError("staticStretch must be positive");
  const marks = src.kind === "video" && options.marks !== undefined ? loadMarks(options.marks) : null;
  const browser = options.browser ?? (await launch(options.launchOptions));
  const ownsBrowser = !options.browser;
  let renderer: Renderer | null = null;
  let context: BrowserContext | null = null;
  try {
    renderer = await Renderer.open(browser);
    if (src.kind === "video") {
      const built = await inspectVideo(src, browser, renderer, { ...options, marks }, autoScale);
      return new Inspection(built.report, built.images, built.paths);
    }
    const parsed = src.text ? await parseSource(renderer.page, src.text, src.kind) : null;
    const viewport = options.size ?? defaultSize(src.kind, parsed);
    const dsf = options.scale ?? (options.size ? 1 : autoScale(viewport));
    context = await browser.newContext({
      viewport: { width: viewport[0], height: viewport[1] },
      deviceScaleFactor: dsf,
      colorScheme: options.colorScheme ?? "light",
      reducedMotion: "no-preference",
      locale: "en-US",
      timezoneId: "UTC",
    });
    const page = await context.newPage();
    page.setDefaultTimeout(options.timeout ?? 30_000);
    const consoleErrors: string[] = [];
    listenForErrors(page, consoleErrors);
    await serve(context, src, options.blockNetwork ?? false);
    // pauseAt() installs the fake clock itself. A separate install() first would let the
    // real time between the two calls leak into performance.now() (Playwright replays it
    // as running time), shifting rAF-driven frames from run to run.
    await page.clock.pauseAt(EPOCH + 1000);
    const response = await page.goto(src.url, { waitUntil: "load" });
    let text = src.text;
    if (text === null && response) text = await response.text().catch(() => null);
    const driver = new Driver(page, page.mainFrame(), true);
    await driver.inject();
    await driver.start();
    const isSvgDoc = Boolean(await driver.js("window.__framesheet.isSvgDoc"));
    const findings = text ? await runStaticChecks(renderer.page, src.kind, text) : [];
    return await pipeline({
      driver,
      renderer,
      label: src.label,
      title: titleOf(src.label),
      kind: src.kind,
      viewport,
      dsf,
      isSvgDoc,
      staticFindings: findings,
      consoleErrors,
      overflow: src.kind === "html",
      options,
    });
  } catch (err) {
    if (isMissingBrowser(err)) throw new BrowserNotInstalledError(err);
    throw err;
  } finally {
    await context?.close().catch(() => undefined);
    await renderer?.close();
    if (ownsBrowser) await browser.close().catch(() => undefined);
  }
}

async function serve(context: BrowserContext, src: Source, blockNetwork: boolean): Promise<void> {
  if (src.body !== undefined) {
    const body = src.body;
    const type = src.kind === "svg" ? "image/svg+xml" : "text/html";
    await context.route(src.url, (route) => route.fulfill({ status: 200, contentType: `${type}; charset=utf-8`, body }));
  }
  if (blockNetwork) {
    await context.route(
      (url) => url.href !== src.url && !url.href.startsWith(`${VIRTUAL_ORIGIN}/input.`),
      (route) => route.abort("blockedbyclient"),
    );
    // route() only sees HTTP(S); WebSockets need their own handler (Playwright >= 1.48).
    if (typeof context.routeWebSocket === "function") {
      await context.routeWebSocket(/.*/, (ws) => ws.close({ code: 1008, reason: "blocked by framesheet" }));
    }
  }
}

const PREPARED_FLAG = "__framesheetPrepared";

export interface PrepareOptions {
  /**
   * Freeze time from navigation on, exactly like `inspect()` does: JS-driven motion that
   * starts on load is captured from its first frame, byte for byte. The page's timers,
   * rAF and `Date` stand still until an inspection (or `page.clock.runFor`) advances
   * them, which suits component pages and stories better than whole apps.
   * Default false: the fake clock follows real time and the app behaves normally.
   */
  paused?: boolean;
}

/**
 * Install Playwright's fake clock on a page **before navigation** (`goto`), so that
 * `inspectPage` can also step JavaScript-driven motion (requestAnimationFrame, timers,
 * `Date`, `performance.now`: canvas, rAF/spring animation libraries) frame by frame.
 *
 * By default the clock keeps running in real time until an inspection pauses it, so the
 * app behaves normally; after each inspection it runs on again. With `paused: true` time
 * is frozen from the start (see {@link PrepareOptions.paused}). Not needed for SMIL, CSS
 * animations/transitions or Web Animations, which are seeked directly on any page.
 */
export async function prepare(page: Page, options: PrepareOptions = {}): Promise<void> {
  const mode = options.paused ? "paused" : "running";
  if (options.paused) {
    // pauseAt() installs the clock; no install() first (see inspect()).
    await page.clock.pauseAt(EPOCH + 1000);
  } else {
    await page.clock.install();
  }
  await page.addInitScript(`window.${PREPARED_FLAG} = ${JSON.stringify(mode)};`);
}

async function scopeBox(handle: ElementHandle<Element>, padding: number, page: Page): Promise<Clip> {
  await handle.scrollIntoViewIfNeeded().catch(() => undefined);
  const box = await handle.boundingBox();
  if (!box) throw new Error("inspectPage: the locator is not visible (no bounding box)");
  const vp = page.viewportSize() ?? (await page.evaluate(() => ({ width: innerWidth, height: innerHeight })));
  const x0 = Math.max(0, Math.floor(box.x - padding));
  const y0 = Math.max(0, Math.floor(box.y - padding));
  const x1 = Math.min(vp.width, Math.ceil(box.x + box.width + padding));
  const y1 = Math.min(vp.height, Math.ceil(box.y + box.height + padding));
  if (x1 <= x0 || y1 <= y0) throw new Error("inspectPage: the locator is outside the viewport");
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/**
 * Inspect a page you already have open (e.g. in a Playwright test), or one component of it
 * (`locator`). Same sampling, checks, images and report as {@link inspect}.
 *
 * Works on any page for SMIL, CSS animations/transitions and Web Animations. For JS-driven
 * motion call {@link prepare} before navigating. The page is handed back afterwards
 * (animations resumed, fake clock running again), but seeked animations continue from
 * where the inspection left them.
 */
export async function inspectPage(page: Page, options: InspectPageOptions = {}): Promise<Inspection> {
  validate(options);
  const locator = options.locator;
  const prepared = (await page.evaluate(`window.${PREPARED_FLAG} || null`)) as "paused" | "running" | null;
  const clockControlled = options.clock ?? prepared !== null;
  const consoleErrors: string[] = [];
  const unlisten = listenForErrors(page, consoleErrors);
  const browser = page.context().browser();
  const renderer = await Renderer.open(browser ?? page.context());
  let handle: ElementHandle<Element> | null = null;
  let driver: Driver | null = null;
  let paused = false;
  try {
    if (clockControlled && prepared !== "paused") {
      // Pause on a 16 ms tick boundary a little in the future (the jump fires due timers
      // once): fake rAF callbacks are aligned to ticks % 16, so this gives the same frame
      // phase on every run. Date.now() - performance.now() is constant on the fake clock,
      // so the target does not depend on how long this round trip takes.
      const [date, perf] = (await page.evaluate("[Date.now(), performance.now()]")) as [number, number];
      const ticks = Math.ceil((perf + 250) / 16) * 16;
      await page.clock.pauseAt(date - perf + ticks);
      paused = true;
    }
    if (options.trigger) await options.trigger();
    handle = locator
      ? ((await locator.elementHandle({ timeout: options.timeout ?? 30_000 })) as ElementHandle<Element>)
      : null;
    const frame = handle ? ((await handle.ownerFrame()) ?? page.mainFrame()) : page.mainFrame();
    driver = new Driver(page, frame, clockControlled);
    await driver.inject();
    await driver.scope(handle);
    await driver.start();
    if (handle) driver.clip = await scopeBox(handle, options.padding ?? 0, page);
    const vp = page.viewportSize() ?? { width: 0, height: 0 };
    const dsf = Number(await page.evaluate("window.devicePixelRatio")) || 1;
    const scopeIsSvg = handle ? await handle.evaluate((el) => el instanceof SVGElement) : false;
    const isSvgDoc = scopeIsSvg || Boolean(await driver.js("window.__framesheet.isSvgDoc"));
    const kind: SourceKind = isSvgDoc ? "svg" : "html";
    let findings: Finding[] = [];
    if (options.staticChecks) {
      const markup = handle
        ? await handle.evaluate((el) => el.outerHTML)
        : await frame.evaluate(() => document.documentElement.outerHTML);
      findings = await runStaticChecks(renderer.page, kind, markup);
    }
    const url = frame.url();
    const label = locator ? `${url} ${String(locator)}` : url;
    return await pipeline({
      driver,
      renderer,
      label,
      title: options.title ?? (locator ? String(locator) : safePath(url)),
      kind,
      viewport: [vp.width, vp.height],
      dsf,
      isSvgDoc,
      staticFindings: findings,
      consoleErrors,
      overflow: true,
      options,
    });
  } finally {
    unlisten();
    await driver?.resume();
    if (paused) await page.clock.resume().catch(() => undefined);
    await handle?.dispose().catch(() => undefined);
    await renderer.close();
  }
}

function safePath(url: string): string {
  try {
    const u = new URL(url);
    return u.protocol.startsWith("http") ? u.pathname : titleOf(url);
  } catch {
    return url;
  }
}

interface PipelineInput {
  driver: Driver;
  renderer: Renderer;
  label: string;
  title: string;
  kind: SourceKind;
  viewport: [number, number];
  dsf: number;
  isSvgDoc: boolean;
  staticFindings: Finding[];
  consoleErrors: string[];
  overflow: boolean;
  options: SampleOptions;
}

async function pipeline(p: PipelineInput): Promise<Inspection> {
  const { driver: s, options } = p;
  const frames = options.frames ?? 12;
  const at = options.at ?? 0;
  const heatFrames = options.heatFrames ?? 48;
  const findings = [...p.staticFindings];
  const animations = parseTimings(await s.js<unknown[]>("window.__framesheet.timings()"));
  const info = detectDuration(animations, options.duration);
  const times = sampleTimes(info.seconds, frames);
  const eps = pyRound(epsilon(info.seconds), 4);
  const description = await s.js<import("./analysis.js").Description[]>("window.__framesheet.describe()");
  const targets = await s.js<Record<string, string[]>>("window.__framesheet.animatedTargets()");
  const canvas = asRect(await s.js<number[]>("window.__framesheet.canvasRect()"));
  const viewbox = await s.js<number[] | null>("window.__framesheet.viewBox()");

  const measured = new Set([...times, eps, at]);
  const extra = new Set(Array.from({ length: heatFrames }, (_, i) => pyRound((info.seconds * i) / heatFrames, 4)));
  const last = times[times.length - 1];
  const snaps = new Map<number, Snapshot>();
  const decoded = new Map<number, Frame>();
  const motion = new MotionAccumulator();
  for (const t of [...new Set([...measured, ...extra])].sort((a, b) => a - b)) {
    let png: Buffer;
    if (measured.has(t)) {
      const snap = await s.snapshot(t, p.overflow);
      snaps.set(t, snap);
      png = snap.png;
    } else {
      png = await s.screenshot(t);
    }
    const isSheetFrame = measured.has(t);
    if (t <= last || isSheetFrame) {
      const frame = decode(png);
      if (isSheetFrame) decoded.set(t, frame);
      if (t <= last) motion.add(frame);
    }
  }
  const consoleErrors = [...p.consoleErrors];

  const sheetSnaps = times.map((t) => snaps.get(t)!);
  const sheetFrames = times.map((t) => decoded.get(t)!);
  const metrics = frameMetrics(sheetFrames, times, p.dsf);
  const moving = metrics.some((m) => m.changed_ratio > 0);
  findings.push(...motionFindings(info, moving));
  const loop = loopInfo(info, moving, decoded.get(times[0])!, decoded.get(eps)!, sheetFrames[sheetFrames.length - 1], p.dsf);
  if (loop.checked && loop.seamless === false) {
    findings.push({
      severity: "warning",
      code: "non-seamless-loop",
      message: `The loop jumps at the cycle end: ${loop.detail}.`,
      check: "render",
      element: null,
      times: [last, 0],
    });
  }
  const geo = Geometry.build(description, sheetSnaps, {
    canvas,
    viewbox: viewbox ? asRect(viewbox) : null,
    targets,
    animations,
    isSvgDoc: p.isSvgDoc,
  });
  findings.push(...runChecks(geo));
  for (const msg of consoleErrors.slice(0, MAX_CONSOLE_ERRORS)) {
    findings.push({ severity: "warning", code: "console-error", message: msg, check: "render", element: null, times: null });
  }
  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

  // Images.
  const span = `${times.length} frames over 0-${g(info.seconds)}s`;
  const how = { override: "set by --duration", detected: "detected", fallback: "fallback", media: "media" }[info.method];
  const looping = info.looping ? "looping" : "not looping";
  const sheet = await contactSheet(
    p.renderer,
    sheetSnaps.map((snap, i) => ({ png: snap.png, width: sheetFrames[i].width, height: sheetFrames[i].height })),
    times.map((t, i) => sheetLabel(t, i, times.length)),
    {
      title: p.title,
      subtitle: `${span} (${how}, ${looping}); last tile = 1 frame before the end`,
      tile: options.tile,
      columns: options.columns,
      highlight: [0, times.length - 1],
    },
  );
  const heat = await heatmap(p.renderer, motion.first!, motion.acc!, {
    title: `${p.title}: motion heatmap`,
    subtitle: `pixels that change across ${motion.count} frames over 0-${g(info.seconds)}s; background = t=0, dimmed`,
    boxes: motion.box ? [motion.box] : [],
  });
  const images: ImageBuffers = { full: snaps.get(at)!.png, sheet, heatmap: heat };
  if (options.keepFrames) images.frames = sheetSnaps.map((snap) => snap.png);

  const out = options.out ? resolvePath(options.out) : null;
  const paths: ImagePaths = out
    ? {
        full: join(out, "full.png"),
        sheet: join(out, "sheet.png"),
        heatmap: join(out, "heatmap.png"),
        report: join(out, "report.json"),
      }
    : { full: "full.png", sheet: "sheet.png", heatmap: "heatmap.png", report: "report.json" };
  if (options.keepFrames) {
    for (const m of metrics) m.path = join(out ?? "", "frames", `frame_${String(m.index).padStart(3, "0")}.png`);
  }
  const report: Report = {
    source: p.label,
    kind: p.kind,
    viewport: p.viewport,
    device_scale_factor: p.dsf,
    canvas,
    duration: info,
    times,
    full_at: at,
    images: paths,
    findings,
    frames: metrics,
    elements: tracks(geo),
    loop,
    console_errors: consoleErrors,
    video: null,
    marks: null,
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
  return new Inspection(report, images, out ? paths : null);
}

function sheetLabel(t: number, i: number, count: number): string {
  const label = `t=${fixed(t, 2)}s`;
  if (i === 0) return `${label}  start`;
  if (i === count - 1) return `${label}  end`;
  return label;
}

function frameMetrics(frames: Frame[], times: number[], scale: number): FrameMetrics[] {
  const out: FrameMetrics[] = [{ index: 0, t: times[0], changed_ratio: 0, changed_box: null, path: null }];
  for (let i = 1; i < frames.length; i++) {
    const [ratio, box] = diffStats(frames[i - 1], frames[i]);
    out.push({ index: i, t: times[i], changed_ratio: pyRound(ratio, 5), changed_box: toCss(box, scale), path: null });
  }
  return out;
}

function motionFindings(info: DurationInfo, moving: boolean): Finding[] {
  const finding = (severity: Severity, code: string, message: string): Finding => ({
    severity,
    code,
    message,
    check: "render",
    element: null,
    times: null,
  });
  if (info.method === "fallback" && moving) {
    info.looping = true;
    return [
      finding(
        "warning",
        "js-driven-motion",
        "Pixels change but no SMIL/CSS/Web Animation was found: motion is JS-driven " +
          `(rAF/canvas/timers). Sampled ${g(info.seconds)}s; pass --duration with the ` +
          "real cycle length.",
      ),
    ];
  }
  if (!moving && info.animations.length) {
    return [
      finding(
        "info",
        "no-visible-motion",
        `${info.animations.length} animation(s) declared, but no pixel changed between sampled frames.`,
      ),
    ];
  }
  if (!moving) return [finding("info", "no-motion", "No animation found and no pixel changed: static.")];
  return [];
}

function loopInfo(info: DurationInfo, moving: boolean, first: Frame, afterFirst: Frame, last: Frame, scale: number): LoopInfo {
  const base = { seamless: null, seam_ratio: null, step_ratio: null, seam_box: null };
  if (!moving) return { checked: false, ...base, detail: "no motion" };
  if (!info.looping) return { checked: false, ...base, detail: "finite animation (does not repeat)" };
  if (info.method === "fallback") {
    return { checked: false, ...base, detail: "cycle length unknown (JS-driven); pass --duration" };
  }
  const [seam, box] = diffStats(last, first);
  const [step] = diffStats(first, afterFirst);
  const seamless = seam <= SEAM_MIN_RATIO || seam <= SEAM_STEP_FACTOR * step + SEAM_MIN_RATIO / 2;
  const detail = `last frame -> first frame changes ${pct(seam, 2)} of pixels, one normal step changes ${pct(step, 2)}`;
  const seamBox: Rect | null = seamless ? null : toCss(box, scale);
  return {
    checked: true,
    seamless,
    seam_ratio: pyRound(seam, 5),
    step_ratio: pyRound(step, 5),
    seam_box: seamBox,
    detail,
  };
}
