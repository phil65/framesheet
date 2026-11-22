/**
 * framesheet: frame-accurate contact sheets, motion heatmaps and checks for animated
 * SVG/HTML and for components in running web apps (Playwright + Chromium).
 *
 * Same report schema and image layout as the Python package `framesheet`.
 */

export { CHECKS, Geometry, runChecks, tracks } from "./analysis.js";
export { checkCss, checkHtmlParsed, checkSvgParsed, parseSource } from "./checks.js";
export { autoTile, defaultColumns, sheetLayout } from "./compose.js";
export { RUNTIME_JS, RUNTIME_SHA256 } from "./generated/assets.js";
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
  Rect,
  Report,
  Severity,
  SourceKind,
} from "./models.js";
export { looksLikeSvg, parseSize } from "./sources.js";
export { detectDuration, epsilon, sampleTimes } from "./timing.js";
