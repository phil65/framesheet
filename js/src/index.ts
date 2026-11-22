/**
 * framesheet: frame-accurate contact sheets, motion heatmaps and checks for animated
 * SVG/HTML and for components in running web apps (Playwright + Chromium).
 *
 * Same report schema and image layout as the Python package `framesheet`.
 */

export { CHECKS, Geometry, runChecks, tracks } from "./analysis.js";
export { checkCss, checkHtmlParsed, checkSvgParsed, parseSource } from "./checks.js";
export { autoTile, defaultColumns, sheetLayout } from "./compose.js";
export { RUNTIME_JS, RUNTIME_SHA256, VIDEO_JS, VIDEO_SHA256 } from "./generated/assets.js";
export {
  BrowserNotInstalledError,
  EPOCH,
  INSTALL_HINT,
  Inspection,
  type InspectOptions,
  type InspectPageOptions,
  inspect,
  inspectPage,
  LAUNCH_ARGS,
  prepare,
  type PrepareOptions,
  type SampleOptions,
  summarize,
} from "./inspect.js";
export type {
  ActivitySample,
  AnimationKind,
  AnimationTiming,
  ColorScheme,
  DurationInfo,
  ElementTrack,
  Finding,
  FrameMetrics,
  ImageBuffers,
  ImagePaths,
  LoopInfo,
  MarkPoint,
  MarkRegion,
  Marks,
  MarkSpan,
  Rect,
  Report,
  Severity,
  SourceKind,
  VideoInfo,
  VideoTile,
} from "./models.js";
export { activeLabels, loadMarks, MarksError, parseMarks, tileOps, tileWindows, timelineOps } from "./marks.js";
export { probe, type Probe, sniff } from "./media.js";
export { looksLikeSvg, parseSize } from "./sources.js";
export { abruptCuts, denseTimes, planTimes, staticStretches, type TimesSpec } from "./video.js";
export { detectDuration, epsilon, sampleTimes } from "./timing.js";
