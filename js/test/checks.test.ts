// Static checks (port of tests/test_checks.py). Parsing runs in the browser (DOMParser).
import { readFileSync } from "node:fs";
import type { Page } from "playwright-core";
import { beforeAll, describe, expect, it } from "vitest";
import { checkHtmlParsed, checkSvgParsed, parseSource } from "../src/checks.js";
import type { Finding } from "../src/models.js";
import { fixture, useBrowser } from "./helpers.js";

const browser = useBrowser();
let page: Page;
beforeAll(async () => {
  page = await browser().newPage();
});

const codes = (findings: Finding[]) => new Set(findings.map((f) => f.code));
const svg = async (raw: string) => checkSvgParsed(raw, await parseSource(page, raw, "svg"));
const html = async (raw: string) => checkHtmlParsed(raw, await parseSource(page, raw, "html"));
const SVG = (inner: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><title>t</title>${inner}</svg>`;

describe("static checks", () => {
  it("passes the clean fixture", async () => {
    expect(await svg(readFileSync(fixture("pipeline.svg"), "utf8"))).toEqual([]);
  });

  it("reports malformed XML", async () => {
    expect(codes(await svg("<svg><g></svg>"))).toEqual(new Set(["malformed-xml"]));
  });

  it("reports root namespace, viewBox and title", async () => {
    const found = codes(await svg("<svg/>"));
    for (const code of ["missing-xmlns", "missing-viewbox", "missing-title"]) expect(found).toContain(code);
  });

  it("reports script, handlers, external URLs, foreignObject", async () => {
    const found = codes(
      await svg(
        SVG(
          '<script>1</script><rect onclick="x()"/><image href="https://example.com/a.png"/><foreignObject/>',
        ),
      ),
    );
    for (const code of ["script", "event-handler", "external-url", "foreign-object"]) expect(found).toContain(code);
  });

  it("reports duplicate and broken ids", async () => {
    const found = await svg(SVG('<g id="a"/><g id="a"/><use href="#missing"/><rect fill="url(#nope)"/>'));
    expect(codes(found)).toEqual(new Set(["duplicate-id", "broken-ref"]));
    expect(found.filter((f) => f.code === "broken-ref")).toHaveLength(2);
  });

  it("resolves xlink:href references", async () => {
    const raw =
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10">' +
      '<title>t</title><path id="p" d="M0 0"/><use xlink:href="#p"/><use xlink:href="#gone"/></svg>';
    const found = await svg(raw);
    expect(found.map((f) => f.message)).toEqual(["Broken internal reference '#gone' (no matching id)."]);
  });

  it("reports positive animateMotion begin only", async () => {
    expect(codes(await svg(SVG('<animateMotion begin="1s"/>')))).toContain("positive-begin");
    expect(codes(await svg(SVG('<animateMotion begin="-0.5s"/>')))).not.toContain("positive-begin");
  });

  it("runs CSS checks", async () => {
    const css = "<style>@keyframes s { to { transform: rotate(1turn) } } .a { animation: s 1s }</style>";
    const found = codes(await svg(SVG(css)));
    expect(found).toContain("no-reduced-motion");
    expect(found).toContain("transform-without-box");
    const origin = "<style>.a { transform: rotate(4deg); transform-origin: center }</style>";
    expect(codes(await svg(SVG(origin)))).toContain("transform-origin-without-box");
  });

  it("ignores CSS comments", async () => {
    const css =
      "<style>/* transform-box: fill-box */ @keyframes s { to { transform: scale(2) } }" +
      " .a { animation: s 1s } @media (prefers-reduced-motion: reduce) {}</style>";
    expect(codes(await svg(SVG(css)))).toContain("transform-without-box");
  });

  it("reports large files", async () => {
    expect(codes(await svg(SVG(`<!--${"x".repeat(120_000)}-->`)))).toContain("large-file");
  });

  it("checks HTML", async () => {
    const raw =
      '<html><body><div id="a"></div><p id="a"></p><a href="#top">top</a>' +
      '<svg><use href="#gone"/></svg><style>.x { animation: y 1s }</style></body></html>';
    expect(codes(await html(raw))).toEqual(new Set(["duplicate-id", "broken-ref", "no-reduced-motion"]));
  });
});
