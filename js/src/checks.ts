/**
 * Static (source-level) checks, port of checks.py.
 *
 * Python parses with `xml.etree` / `html.parser`; here the browser's `DOMParser` does the
 * parsing (no extra dependencies) and returns a plain element list, and the check logic
 * below runs in Node. Keep codes, severities and messages in step with checks.py.
 */

import type { Page } from "playwright-core";
import type { Finding, Severity } from "./models.js";
import { fixed } from "./pyfmt.js";

export const SVG_NS = "http://www.w3.org/2000/svg";
export const LARGE_SVG_KB = 100;
const URL_REF = /url\(\s*['"]?#([^)'"]+)['"]?\s*\)/g;
const POSITIVE_CLOCK = /^([0-9]*\.?[0-9]+)(ms|s)?$/;
const KEYFRAMES = /@keyframes[^{]*\{((?:[^{}]*\{[^}]*\})*)[^}]*\}/g;
const SVG_REF_TAGS = new Set(["use", "mpath", "textpath", "lineargradient", "radialgradient", "pattern"]);

function urlRefs(value: string): string[] {
  return [...value.matchAll(URL_REF)].map((m) => m[1]);
}

function finding(severity: Severity, code: string, message: string, element: string | null = null): Finding {
  return { severity, code, message, check: "static", element, times: null };
}

/** One parsed element: local tag name, attributes as `[localName, qualifiedName, value]`. */
export interface ParsedElement {
  tag: string;
  attrs: [string, string, string][];
  /** Text content of `<style>` elements, else null. */
  text: string | null;
}

export interface ParsedDocument {
  /** Parser error message (XML only), else null. */
  error: string | null;
  rootTag: string | null;
  rootNs: string | null;
  /** Document order, root first. */
  elements: ParsedElement[];
}

/**
 * Runs in the browser. Kept free of closures: Playwright serialises it.
 * @internal
 */
export function parseInPage([raw, mime]: [string, "image/svg+xml" | "text/html"]): ParsedDocument {
  const XMLNS = "http://www.w3.org/2000/xmlns/";
  const doc = new DOMParser().parseFromString(raw, mime);
  if (mime !== "text/html") {
    const err = doc.getElementsByTagName("parsererror")[0];
    if (err) {
      const detail = err.querySelector("div");
      const text = (detail ? detail.textContent : err.textContent) || "parse error";
      return { error: text.trim().replace(/\s+/g, " "), rootTag: null, rootNs: null, elements: [] };
    }
  }
  const root = doc.documentElement;
  const all = mime === "text/html" ? [...doc.querySelectorAll("*")] : [root, ...root.querySelectorAll("*")];
  return {
    error: null,
    rootTag: root ? root.localName : null,
    rootNs: root ? root.namespaceURI : null,
    elements: all.map((el) => ({
      tag: el.localName,
      attrs: [...el.attributes]
        .filter((a) => a.namespaceURI !== XMLNS)
        .map((a) => [a.localName, a.name, a.value] as [string, string, string]),
      text: el.localName === "style" ? el.textContent : null,
    })),
  };
}

/** Parse `raw` with the browser's DOMParser on `page` (any page, e.g. about:blank). */
export async function parseSource(page: Page, raw: string, kind: "svg" | "html"): Promise<ParsedDocument> {
  return page.evaluate(parseInPage, [raw, kind === "svg" ? "image/svg+xml" : "text/html"] as [
    string,
    "image/svg+xml" | "text/html",
  ]);
}

function keyframesTransform(css: string): boolean {
  return [...css.matchAll(KEYFRAMES)].some((m) => /\b(transform|rotate|scale|translate)\s*:/.test(m[1]));
}

/** Checks on the concatenated text of all `<style>` blocks. */
export function checkCss(cssText: string, { svg }: { svg: boolean }): Finding[] {
  const out: Finding[] = [];
  const css = cssText.replace(/\/\*[\s\S]*?\*\//g, "");
  if (!css.trim()) return out;
  if (/@import\s+url\(|https?:\/\//.test(css)) {
    out.push(
      finding(
        "warning",
        "css-external",
        "CSS references an external URL/font (blocked when the SVG is used as <img>).",
      ),
    );
  }
  const animated = /\banimation(-name)?\s*:/.test(css);
  if (animated && !css.includes("prefers-reduced-motion")) {
    out.push(
      finding(
        "warning",
        "no-reduced-motion",
        "CSS animations present without @media (prefers-reduced-motion: reduce).",
      ),
    );
  }
  if (svg && !css.includes("transform-box")) {
    const hasTransform = /\btransform\s*:/.test(css);
    if (hasTransform && css.includes("transform-origin")) {
      out.push(
        finding(
          "warning",
          "transform-origin-without-box",
          "CSS transform-origin used without transform-box: fill-box; may pivot " +
            "unexpectedly across SVG renderers.",
        ),
      );
    } else if (animated && keyframesTransform(css)) {
      out.push(
        finding(
          "warning",
          "transform-without-box",
          "CSS @keyframes animate transform/rotate/scale but no transform-box is set; " +
            "SVG elements then rotate/scale around the SVG origin (0,0). Add " +
            "transform-box: fill-box; transform-origin: center.",
        ),
      );
    }
  }
  return out;
}

function idFindings(ids: Map<string, number>, refs: Set<string>): Finding[] {
  const out: Finding[] = [];
  for (const [id, count] of ids) {
    if (count > 1) out.push(finding("error", "duplicate-id", `Duplicate id='${id}' (${count} occurrences).`));
  }
  for (const ref of [...refs].sort()) {
    if (!ids.has(ref)) out.push(finding("error", "broken-ref", `Broken internal reference '#${ref}' (no matching id).`));
  }
  return out;
}

const attr = (el: ParsedElement, name: string) => el.attrs.find(([local]) => local === name)?.[2];
const labelOf = (el: ParsedElement) => {
  const id = attr(el, "id");
  return id ? `${el.tag}#${id}` : el.tag;
};

/** Static checks for a standalone SVG document (portability, references, pitfalls). */
export function checkSvgParsed(raw: string, doc: ParsedDocument): Finding[] {
  const out: Finding[] = [];
  const sizeKb = Buffer.byteLength(raw, "utf8") / 1024;
  if (sizeKb > LARGE_SVG_KB) {
    out.push(
      finding("warning", "large-file", `Large SVG (${fixed(sizeKb, 1)} KB); consider simplifying paths or defs.`),
    );
  }
  if (doc.error !== null) return [...out, finding("error", "malformed-xml", `Malformed XML: ${doc.error}`)];
  const root = doc.elements[0];
  if (doc.rootTag !== "svg") {
    out.push(finding("error", "not-svg", `Root element is <${doc.rootTag}>, expected <svg>.`));
  }
  if (doc.rootNs !== SVG_NS) {
    out.push(finding("error", "missing-xmlns", 'Missing xmlns="http://www.w3.org/2000/svg".'));
  }
  if (!attr(root, "viewBox")) out.push(finding("error", "missing-viewbox", "Missing viewBox attribute on <svg>."));
  const hasTitle = doc.elements.some((el) => el.tag === "title");
  if (!(attr(root, "aria-label") || hasTitle)) {
    out.push(finding("warning", "missing-title", "Missing aria-label or <title> for accessibility."));
  }
  const ids = new Map<string, number>();
  const refs = new Set<string>();
  const cssBlocks: string[] = [];
  for (const el of doc.elements) {
    const { tag } = el;
    const id = attr(el, "id");
    if (id) ids.set(id, (ids.get(id) ?? 0) + 1);
    if (tag === "script") {
      out.push(finding("error", "script", "Contains <script>, which is stripped by GitHub and blocked in <img>."));
    }
    if (tag === "foreignObject") {
      out.push(
        finding("warning", "foreign-object", "Contains <foreignObject>, which breaks in many <img>/SVG viewers."),
      );
    }
    for (const [name, , value] of el.attrs) {
      if (name.startsWith("on")) {
        out.push(
          finding("error", "event-handler", `Inline event handler '${name}' on <${tag}> (stripped in <img>).`, labelOf(el)),
        );
      }
      if (/https?:\/\//.test(value) && name !== "xmlns") {
        out.push(
          finding(
            "warning",
            "external-url",
            `External URL in ${name}='${value}' on <${tag}> (blocked in GitHub <img>).`,
            labelOf(el),
          ),
        );
      }
      for (const ref of urlRefs(value)) refs.add(ref);
      if (name === "href" && value.startsWith("#")) refs.add(value.slice(1));
    }
    if (tag === "animateMotion") {
      const begin = (attr(el, "begin") ?? "").trim();
      const m = POSITIVE_CLOCK.exec(begin);
      if (m && parseFloat(m[1]) > 0) {
        out.push(
          finding(
            "warning",
            "positive-begin",
            `<animateMotion begin='${begin}'> uses a positive delay; the parent ` +
              "shape may park at (0,0) before start. Use a negative begin offset.",
          ),
        );
      }
    }
    if (tag === "style" && el.text) cssBlocks.push(el.text);
  }
  const css = cssBlocks.join("\n");
  for (const ref of urlRefs(css)) refs.add(ref);
  out.push(...idFindings(ids, refs), ...checkCss(css, { svg: true }));
  return out;
}

/** Static checks for an HTML document: ids, internal references, reduced motion. */
export function checkHtmlParsed(raw: string, doc: ParsedDocument): Finding[] {
  const ids = new Map<string, number>();
  const refs = new Set<string>();
  const css: string[] = [];
  for (const el of doc.elements) {
    const tag = el.tag.toLowerCase();
    for (const [, qualified, value] of el.attrs) {
      const name = qualified.toLowerCase();
      if (name === "id") ids.set(value, (ids.get(value) ?? 0) + 1);
      for (const ref of urlRefs(value)) refs.add(ref);
      // Only SVG-style fragment references; HTML <a href="#top"> is navigation.
      if ((name === "xlink:href" || name === "href") && value.startsWith("#") && SVG_REF_TAGS.has(tag)) {
        refs.add(value.slice(1));
      }
    }
    if (tag === "style" && el.text) css.push(el.text);
  }
  const cssText = css.join("\n");
  for (const ref of urlRefs(cssText)) refs.add(ref);
  return [...idFindings(ids, refs), ...checkCss(cssText, { svg: raw.toLowerCase().includes("<svg") })];
}

/** All static findings for one source text (parsed on `page`). */
export async function staticFindings(page: Page, kind: "svg" | "html", text: string | null): Promise<Finding[]> {
  if (!text) return [];
  const doc = await parseSource(page, text, kind);
  return kind === "svg" ? checkSvgParsed(text, doc) : checkHtmlParsed(text, doc);
}
