// inspectPage(): pages and components in a running app (what an e2e suite does).
import type { BrowserContext, Page } from "playwright-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inspectPage, prepare } from "../src/index.js";
import { decode } from "../src/pixels.js";
import { useBrowser } from "./helpers.js";

const browser = useBrowser();
let context: BrowserContext;
let page: Page;
const ORIGIN = "http://app.test";

/** Serve `html` at http://app.test/<path> (no network). */
async function serve(path: string, html: string): Promise<string> {
  await context.route(`${ORIGIN}${path}`, (route) =>
    route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }),
  );
  return `${ORIGIN}${path}`;
}

beforeEach(async () => {
  context = await browser().newContext({ viewport: { width: 800, height: 500 } });
  page = await context.newPage();
});
afterEach(async () => {
  await context.close();
});

const APP = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  body { margin: 0; background: #f8fafc; font: 14px sans-serif; }
  /* Unrelated chrome with its own (7 s) animation: must not affect the component. */
  .spinner { position: absolute; right: 20px; top: 20px; width: 20px; height: 20px; background: #64748b;
             animation: spin 7s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  #widget { position: absolute; left: 40px; top: 60px; width: 400px; height: 200px; }
</style></head><body>
  <div class="spinner"></div>
  <svg id="widget" viewBox="0 0 400 200" role="img" aria-label="w">
    <rect width="400" height="200" fill="#0f172a"/>
    <path id="wire" d="M 60 100 C 140 20, 260 180, 340 100" fill="none" stroke="#334155" stroke-width="3"/>
    <circle id="dot" r="8" fill="#f59e0b">
      <animateMotion dur="2s" begin="1s" repeatCount="indefinite"><mpath href="#wire"/></animateMotion>
    </circle>
  </svg>
</body></html>`;

describe("inspectPage", () => {
  it("scopes a locator: duration, findings, geometry and image size", async () => {
    await page.goto(await serve("/app", APP));
    const r = await inspectPage(page, { locator: page.locator("#widget"), frames: 6, heatFrames: 12 });
    expect(r.report.duration.seconds).toBeCloseTo(3); // 1 s begin + 2 s loop; spinner ignored
    expect(r.report.duration.animations.map((a) => a.kind)).toEqual(["smil"]);
    expect(r.report.kind).toBe("svg");
    expect(r.report.canvas).toEqual([40, 60, 400, 200]);
    const parked = r.findings.find((f) => f.code === "parked-at-origin");
    expect(parked?.element).toBe("circle#dot");
    expect(r.report.elements.map((e) => e.element)).toEqual(["circle#dot"]);
    const full = decode(r.images.full);
    expect([full.width, full.height]).toEqual([400, 200]);
    expect(r.findings.filter((f) => f.check === "static")).toEqual([]);
  });

  it("hands the page back (animations and SMIL resumed)", async () => {
    await page.goto(await serve("/app", APP));
    await inspectPage(page, { locator: page.locator("#widget"), frames: 3, heatFrames: 0 });
    const state = await page.evaluate(() => ({
      smilPaused: (document.getElementById("widget") as unknown as SVGSVGElement).animationsPaused(),
      css: document.getAnimations().map((a) => a.playState),
    }));
    expect(state.smilPaused).toBe(false);
    expect(state.css).toEqual(["running"]);
  });

  it("is byte-identical after a fresh navigation (as in an e2e test)", async () => {
    const url = await serve("/app", APP);
    const run = async () => {
      const ctx = await browser().newContext({ viewport: { width: 800, height: 500 } });
      await ctx.route(url, (route) => route.fulfill({ contentType: "text/html", body: APP }));
      const p = await ctx.newPage();
      await p.goto(url);
      await p.waitForTimeout(400);
      const r = await inspectPage(p, { locator: p.locator("#widget"), frames: 4, heatFrames: 8 });
      await ctx.close();
      return r;
    };
    const [a, b] = [await run(), await run()];
    expect(b.report).toEqual(a.report);
    for (const key of ["full", "sheet", "heatmap"] as const) expect(a.images[key].equals(b.images[key]), key).toBe(true);
  });

  it("is repeatable on the same page (geometry exact, pixels within antialiasing)", async () => {
    await page.goto(await serve("/app", APP));
    const opts = { locator: page.locator("#widget"), frames: 4, heatFrames: 8 };
    const a = await inspectPage(page, opts);
    const b = await inspectPage(page, opts);
    expect(b.report.elements).toEqual(a.report.elements);
    expect(b.report.duration).toEqual(a.report.duration);
    // Chromium may re-rasterise a few antialiased edge pixels differently on a page that
    // already painted other states; Playwright's snapshot threshold absorbs that.
    const [x, y] = [decode(a.images.sheet), decode(b.images.sheet)];
    let off = 0;
    for (let i = 0; i < x.data.length; i += 4) {
      if (Math.max(...[0, 1, 2].map((c) => Math.abs(x.data[i + c] - y.data[i + c]))) > 32) off++;
    }
    expect(off / (x.width * x.height)).toBeLessThan(0.0005);
  });

  it("inspects a whole page", async () => {
    await page.goto(await serve("/app", APP));
    const r = await inspectPage(page, { frames: 3, heatFrames: 0, title: "app" });
    expect(r.report.kind).toBe("html");
    expect(r.report.viewport).toEqual([800, 500]);
    // Both animations count now: the spinner's 7 s period joins the widget's 2 s loop.
    expect(r.report.duration.detail).toContain("LCM of loop periods 2s, 7s");
    expect(r.report.duration.seconds).toBe(15);
  });

  it("steps rAF motion after prepare() and a trigger, deterministically", async () => {
    const html = `<!DOCTYPE html><html><body style="margin:0;background:#111827">
      <button id="go" style="position:absolute;left:0;top:0">go</button>
      <canvas id="c" width="400" height="120" style="position:absolute;left:0;top:40px"></canvas>
      <script>
        const ctx = document.getElementById("c").getContext("2d");
        function draw(x) { ctx.fillStyle = "#111827"; ctx.fillRect(0, 0, 400, 120);
          ctx.fillStyle = "#34d399"; ctx.beginPath(); ctx.arc(x, 60, 20, 0, Math.PI * 2); ctx.fill(); }
        draw(30);
        document.getElementById("go").onclick = () => {
          const start = performance.now();
          const frame = () => { const t = (performance.now() - start) / 1000;
            draw(30 + Math.min(t, 1) * 340); if (t < 1) requestAnimationFrame(frame); };
          requestAnimationFrame(frame);
        };
      </script></body></html>`;
    const url = await serve("/raf", html);
    const run = async () => {
      await prepare(page);
      await page.goto(url);
      await page.waitForTimeout(300); // the app runs in real time before the inspection
      return inspectPage(page, {
        locator: page.locator("#c"),
        duration: 1,
        frames: 5,
        heatFrames: 0,
        keepFrames: true,
        trigger: () => page.locator("#go").click(),
      });
    };
    const a = await run();
    expect(a.report.duration.method).toBe("override");
    // The dot starts at x=30 at t=0 (the trigger ran on frozen time) and moves right in
    // even steps of 85 px per 0.25 s: positions follow virtual time, not wall time.
    const centres = (a.images.frames ?? []).map((png) => {
      const f = decode(png);
      const xs: number[] = [];
      for (let x = 0; x < f.width; x++) if (f.data[(60 * f.width + x) * 4 + 1] > 150) xs.push(x);
      return xs.length ? Math.round((xs[0] + xs[xs.length - 1]) / 2) : null;
    });
    expect(centres).toHaveLength(5);
    const expected = [30, 115, 200, 285, 370];
    centres.forEach((c, i) => expect(Math.abs(c! - expected[i]), `frame ${i}: ${centres}`).toBeLessThanOrEqual(8));
    const b = await run();
    expect(a.images.sheet.equals(b.images.sheet)).toBe(true);
    // The fake clock runs again after the inspection.
    const t0 = await page.evaluate(() => Date.now());
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => Date.now())).toBeGreaterThan(t0);
  });

  it("without prepare(), CSS is still frame-accurate", async () => {
    const html = `<!DOCTYPE html><html><head><style>
      body { margin: 0 } #bar { position: absolute; left: 0; top: 0; height: 20px; width: 10px; background: #2563eb;
      animation: grow 2s linear infinite } @keyframes grow { to { width: 210px } }
      @media (prefers-reduced-motion: reduce) { #bar { animation: none } }</style></head>
      <body><div id="bar"></div></body></html>`;
    await page.goto(await serve("/css", html));
    await page.waitForTimeout(700);
    const r = await inspectPage(page, { frames: 5, heatFrames: 0 });
    expect(r.report.duration.seconds).toBe(2);
    const track = r.report.elements.find((e) => e.element === "div#bar")!;
    expect(track.boxes.map((b) => Math.round(b![2]))).toEqual([10, 60, 110, 160, 208]);
  });

  it("inspects a component inside an iframe", async () => {
    const inner = `<!DOCTYPE html><html><body style="margin:0">${APP.slice(APP.indexOf("<svg"), APP.indexOf("</svg>") + 6)}</body></html>`;
    await serve("/inner", inner);
    await page.goto(
      await serve("/outer", `<!DOCTYPE html><body style="margin:0"><iframe src="/inner" style="position:absolute;left:100px;top:50px;width:500px;height:300px;border:0"></iframe></body>`),
    );
    const widget = page.frameLocator("iframe").locator("#widget");
    await widget.waitFor();
    const r = await inspectPage(page, { locator: widget, frames: 4, heatFrames: 0 });
    expect(r.codes()).toContain("parked-at-origin");
    const full = decode(r.images.full);
    expect([full.width, full.height]).toEqual([500, 250]); // fills the 500 px wide iframe
    expect(r.report.canvas).toEqual([0, 0, 500, 250]); // geometry is relative to the iframe
  });
});
