/**
 * Report types: the same shape as the Python package's `report.json`
 * (`framesheet.models.InspectionResult`), checked against ../schema/report.schema.json.
 * Field names are snake_case on purpose: one schema for both implementations.
 */

export type Severity = "error" | "warning" | "info";
export type SourceKind = "svg" | "html" | "video";
export type ColorScheme = "light" | "dark";
/** An axis-aligned box as `[x, y, width, height]`. */
export type Rect = [number, number, number, number];

/** A single problem (or noteworthy fact) found by a static or render check. */
export interface Finding {
  severity: Severity;
  /** Stable, kebab-case identifier, e.g. `parked-at-origin` (see schema/finding-codes.json). */
  code: string;
  message: string;
  check: "static" | "render";
  /** Human-readable element label such as `circle#dot` or `text[2] "Hello"`. */
  element: string | null;
  /** Sample times (seconds) at which the problem was observed. */
  times: number[] | null;
}

export type AnimationKind = "smil" | "css-animation" | "css-transition" | "web-animation";

/** Timing of one declarative animation, as reported by the browser. */
export interface AnimationTiming {
  kind: AnimationKind;
  target: string | null;
  name: string | null;
  /** Begin / delay in seconds (may be negative). */
  start: number;
  /** Duration of one iteration in seconds. */
  duration: number;
  /** Iteration count; `null` means infinite. */
  iterations: number | null;
  direction: string;
  /** Seconds until the animation looks the same again (2x duration for alternate). */
  period: number;
  /** End of the active interval in seconds; `null` if infinite. */
  end: number | null;
  /** Computed `transform-box` of an SVG target whose transform is animated by CSS. */
  transform_box: string | null;
}

export interface DurationInfo {
  seconds: number;
  method: "override" | "detected" | "fallback" | "media";
  /** True if at least one animation repeats forever (or motion is JS-driven). */
  looping: boolean;
  detail: string;
  animations: AnimationTiming[];
}

export interface FrameMetrics {
  index: number;
  t: number;
  /** Share of pixels that differ from the previous frame (0 for the first frame). */
  changed_ratio: number;
  /** Bounding box (CSS px) of the pixels that changed vs. the previous frame. */
  changed_box: Rect | null;
  /** Path of the individual frame PNG, if frames were written. */
  path: string | null;
}

export interface ElementTrack {
  element: string;
  /** `smil`, `css-animation`, `web-animation` and/or `moved` (geometry changed). */
  animated_by: string[];
  units: "viewBox" | "px";
  /** One box per frame (`null` if not rendered at that frame). */
  boxes: (Rect | null)[];
}

export interface LoopInfo {
  checked: boolean;
  seamless: boolean | null;
  /** Changed-pixel share between `t=end-epsilon` and `t=0`. */
  seam_ratio: number | null;
  /** Changed-pixel share between `t=0` and `t=epsilon` (normal motion per step). */
  step_ratio: number | null;
  seam_box: Rect | null;
  detail: string;
}

/** Image paths. Absolute when written to disk (`out`), else bare file names. */
export interface ImagePaths {
  full: string;
  sheet: string;
  heatmap: string;
  report: string;
}

/** Everything framesheet found out about one input: the content of `report.json`. */
export interface Report {
  source: string;
  kind: SourceKind;
  viewport: [number, number];
  device_scale_factor: number;
  /** Drawing area in CSS px (viewBox for SVG documents/components, viewport for HTML). */
  canvas: Rect;
  duration: DurationInfo;
  /** Sample times of the contact-sheet tiles in seconds. */
  times: number[];
  full_at: number;
  images: ImagePaths;
  findings: Finding[];
  frames: FrameMetrics[];
  elements: ElementTrack[];
  loop: LoopInfo;
  console_errors: string[];
  /** Media facts and per-tile metrics (video inputs only). */
  video: VideoInfo | null;
  /** The marks drawn onto the sheet, as validated. */
  marks: Marks | null;
}

/** An instant at a position, e.g. a click: drawn on the tile nearest to `t`. */
export interface MarkPoint {
  t: number;
  x: number;
  y: number;
  label: string | null;
  /** Free-form, e.g. `click`. */
  kind: string | null;
  /** Seconds the point stays relevant (drawn on every tile it overlaps). Default 0. */
  duration: number;
}

/** A time range, optionally with a box: a target element, a zoom, a highlight. */
export interface MarkRegion {
  x: number | null;
  y: number | null;
  w: number | null;
  h: number | null;
  start: number;
  end: number;
  label: string | null;
  /** Free-form, e.g. `zoom`. `target` boxes are checked against span boxes. */
  kind: string | null;
}

/** A labelled time range, e.g. a caption; the optional box is its screen area. */
export interface MarkSpan {
  x: number | null;
  y: number | null;
  w: number | null;
  h: number | null;
  start: number;
  end: number;
  label: string;
  kind: string | null;
}

/**
 * Annotations drawn onto video tiles and the timeline (schema: framesheet/schema/marks.schema.json).
 * Times are seconds of the media; coordinates are fractions (0-1) of the video frame, or
 * pixels of `frame` if given.
 */
export interface Marks {
  frame: { width: number; height: number } | null;
  points: MarkPoint[];
  regions: MarkRegion[];
  spans: MarkSpan[];
}

/** One dense video sample: share of pixels changed since the previous sample. */
export interface ActivitySample {
  t: number;
  changed_ratio: number;
}

/** Per-tile numbers for videos, so an agent can score without looking. */
export interface VideoTile {
  index: number;
  t: number;
  /** Presentation time of the decoded frame (`null` if the browser did not say). */
  media_time: number | null;
  black: boolean;
  /** One flat colour that is not black (e.g. a white page before load). */
  blank: boolean;
  /** Near-identical to the previous tile (changes < 0.05% of pixels). */
  duplicate: boolean;
  /** Mean luma gradient (0-510); compare tiles of one video: drops = blur/upscaling. */
  sharpness: number;
  /** Labels of the marks active on this tile. */
  marks: string[];
}

/** Media facts and dense-sample metrics of a video or animated image. */
export interface VideoInfo {
  container: string;
  codec: string | null;
  decoder: "video" | "image-decoder";
  width: number;
  height: number;
  media_duration: number | null;
  fps: number | null;
  frame_count: number | null;
  start: number;
  end: number;
  /** Seconds without visible change that count as a static stretch. */
  static_threshold: number;
  /** Every sampled time in `[start, end]` (tiles + dense grid), in order. */
  samples: ActivitySample[];
  tiles: VideoTile[];
}

/** PNG bytes of the three images (plus every sampled frame if requested). */
export interface ImageBuffers {
  /** One full-resolution frame at `fullAt` (default t=0): layout, text, margins. */
  full: Buffer;
  /** Contact sheet: N labelled frames over one cycle. */
  sheet: Buffer;
  /** Motion heatmap: what moves at all, over a dimmed first frame. */
  heatmap: Buffer;
  /** Every contact-sheet frame (only with `keepFrames`). */
  frames?: Buffer[];
}

export function asRect(values: ArrayLike<number>): Rect {
  return [Number(values[0]), Number(values[1]), Number(values[2]), Number(values[3])];
}
