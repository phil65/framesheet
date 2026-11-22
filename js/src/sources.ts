/** Input handling: files, markup strings and URLs (port of sources.py). */

import { readFileSync, statSync } from "node:fs";
import { extname, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import type { ParsedDocument } from "./checks.js";
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
