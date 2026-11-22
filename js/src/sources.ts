/** Input handling: files, markup strings and URLs (port of sources.py). */

import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { extname, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import type { ParsedDocument } from "./checks.js";
import { sniff, VIDEO_EXTENSIONS } from "./media.js";
import type { SourceKind } from "./models.js";
import { pyRound } from "./pyfmt.js";

export const DEFAULT_HTML_SIZE: [number, number] = [1280, 720];
export const DEFAULT_SVG_SIZE: [number, number] = [960, 540];
const LENGTH = /^\s*([0-9]*\.?[0-9]+)\s*(px)?\s*$/;
/** Markup strings are served from this virtual origin (page.route), never from disk. */
export const VIRTUAL_ORIGIN = "http://framesheet.invalid";

/** A resolved input. */
export interface Source {
  /** What the caller passed (path, URL, or `<snippet>`). */
  label: string;
  kind: SourceKind;
  /** What the browser navigates to. */
  url: string;
  /** Source text if available (static checks, size detection). */
  text: string | null;
  /** Markup served via page.route at `url` (markup-string inputs only). */
  body?: string;
  /** Video/animated image bytes (`kind === "video"`), served to the wrapper page. */
  media?: Buffer;
  /** Video container (`mp4`, `webm`, `gif`, ...) for video sources. */
  container?: string;
}

/** Video wrapper pages and media are served from this virtual (secure) origin. */
export const VIDEO_ORIGIN = "https://framesheet.invalid";
export const VIDEO_PAGE =
  "<!DOCTYPE html><html><head><meta charset='utf-8'><title>framesheet video</title></head><body></body></html>";

/** A video/animated image, played in a wrapper page on {@link VIDEO_ORIGIN}. */
export function videoSource(label: string, data: Buffer, container: string | null = null): Source {
  const kind = sniff(data) ?? container;
  if (kind === null) throw new Error(`Not a supported video or animated image: ${label}`);
  return { label, kind: "video", url: `${VIDEO_ORIGIN}/video.html`, text: null, media: data, container: kind };
}

function videoExt(name: string): string | null {
  return VIDEO_EXTENSIONS[extname(name.split("?")[0]).toLowerCase()] ?? null;
}

/** Download a video URL (errors are raised: there is nothing to inspect without it). */
export async function fetchBytes(url: string, timeoutMs = 60_000): Promise<Buffer> {
  let response: Response;
  try {
    response = await fetch(url, { headers: { "User-Agent": "framesheet" }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new Error(`Cannot download ${url}: ${(err as Error).message}`);
  }
  if (!response.ok) throw new Error(`Cannot download ${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

export function looksLikeSvg(text: string): boolean {
  let head = text.slice(0, 4096).replace(/<!--[\s\S]*?-->/g, "").trimStart().toLowerCase();
  if (head.startsWith("<?xml")) {
    const i = head.indexOf("?>");
    head = (i >= 0 ? head.slice(i + 2) : "").trimStart();
  }
  if (head.startsWith("<!doctype svg")) return true;
  return head.startsWith("<svg");
}

/** Wrap an in-memory SVG/HTML snippet as a source (served from a virtual URL). */
export function snippet(markup: string, label = "<snippet>"): Source {
  const kind: SourceKind = looksLikeSvg(markup) ? "svg" : "html";
  let text = markup;
  if (kind === "html" && !text.toLowerCase().includes("<html")) {
    text = `<!DOCTYPE html>\n<html><head><meta charset='utf-8'></head><body>${text}</body></html>`;
  }
  return { label, kind, url: `${VIRTUAL_ORIGIN}/input.${kind}`, text, body: text };
}

/** Best-effort download of a URL's body (for static checks and SVG size detection). */
export async function fetchText(url: string, timeoutMs = 15_000): Promise<string | null> {
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "framesheet" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
}

/** Turn a path, URL or markup string (starting with `<`) into a {@link Source}. */
export async function resolveSource(source: string): Promise<Source> {
  if (source.trimStart().startsWith("<")) return snippet(source);
  if (/^https?:\/\//.test(source)) {
    const container = videoExt(source);
    if (container) return videoSource(source, await fetchBytes(source), container);
    const text = await fetchText(source);
    const byName = source.split("?")[0].toLowerCase().endsWith(".svg");
    const kind: SourceKind = byName || (text !== null && looksLikeSvg(text)) ? "svg" : "html";
    return { label: source, kind, url: source, text };
  }
  const path = resolvePath(source.startsWith("file://") ? new URL(source).pathname : source);
  let isFile = false;
  try {
    isFile = statSync(path).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) throw new Error(`Input not found: ${source}`);
  const head = Buffer.alloc(64);
  const fd = openSync(path, "r");
  try {
    readSync(fd, head, 0, 64, 0);
  } finally {
    closeSync(fd);
  }
  const container = videoExt(path);
  if (container || sniff(head)) return videoSource(source, readFileSync(path), container);
  const text = readFileSync(path, "utf8");
  const ext = extname(path).toLowerCase();
  let kind: SourceKind;
  if (ext === ".svg") kind = "svg";
  else if ([".html", ".htm", ".xhtml"].includes(ext)) kind = "html";
  else kind = looksLikeSvg(text) ? "svg" : "html";
  return { label: source, kind, url: pathToFileURL(path).href, text };
}

function length(value: string | undefined): number | null {
  if (value == null) return null;
  const m = LENGTH.exec(value);
  return m ? parseFloat(m[1]) : null;
}

/** Intrinsic size of a parsed SVG: absolute width/height attributes, else the viewBox. */
export function svgSize(doc: ParsedDocument): [number, number] | null {
  if (doc.error !== null || !doc.elements.length) return null;
  const root = doc.elements[0];
  const get = (name: string) => root.attrs.find(([local]) => local === name)?.[2];
  let width = length(get("width"));
  let height = length(get("height"));
  const box = (get("viewBox") ?? "")
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number);
  if (box.length === 4 && box[2] > 0 && box[3] > 0) {
    const [, , vbW, vbH] = box;
    if (width && !height) height = (width * vbH) / vbW;
    else if (height && !width) width = (height * vbW) / vbH;
    width = width || vbW;
    height = height || vbH;
  }
  if (width && height) return [Math.max(1, pyRound(width)), Math.max(1, pyRound(height))];
  return null;
}

export function defaultSize(kind: SourceKind, parsed: ParsedDocument | null): [number, number] {
  if (kind === "svg" && parsed) {
    const size = svgSize(parsed);
    if (size) return size;
  }
  return kind === "svg" ? DEFAULT_SVG_SIZE : DEFAULT_HTML_SIZE;
}

/** Parse `WxH` (e.g. `1280x720`). */
export function parseSize(value: string): [number, number] {
  const m = /^\s*(\d+)\s*[xX*]\s*(\d+)\s*$/.exec(value);
  if (!m) throw new Error(`Invalid size '${value}'; expected WIDTHxHEIGHT, e.g. 1280x720`);
  return [Number(m[1]), Number(m[2])];
}
