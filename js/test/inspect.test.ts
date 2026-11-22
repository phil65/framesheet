// End-to-end: real Chromium, the deliberately flawed fixtures of the Python test suite.
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type Inspection, type InspectOptions, inspect } from "../src/index.js";
import { decode } from "../src/pixels.js";
import { fixture, useBrowser } from "./helpers.js";

const browser = useBrowser();
const cache = new Map<string, Promise<Inspection>>();
function inspected(name: string, options: InspectOptions = {}): Promise<Inspection> {
  const key = `${name} ${JSON.stringify(options)}`;
  if (!cache.has(key)) cache.set(key, inspect(fixture(name), { browser: browser(), ...options }));
  return cache.get(key)!;
}
const codes = (r: Inspection, check?: string) =>
  new Set(r.findings.filter((f) => !check || f.check === check).map((f) => f.code));
const tmp = () => mkdtempSync(join(tmpdir(), "framesheet-js-"));

describe("inspect() on the Python fixtures", () => {
  it("parked dot before a positive begin", async () => {
    const r = await inspected("parked_dot.svg");
    expect(codes(r)).toContain("positive-begin");
    expect(codes(r)).toContain("parked-at-origin");
    const parked = r.findings.find((f) => f.code === "parked-at-origin")!;
    expect(parked.element).toBe("circle#dot");
    expect(parked.times![0]).toBe(0);
    expect(parked.times!.every((t) => t < 1)).toBe(true);
    expect(r.report.duration.seconds).toBeCloseTo(3);
    expect(r.report.duration.method).toBe("detected");
  });

  it("text overflowing its card", async () => {
    const r = await inspected("text_overflow.svg");
    const f = r.findings.find((x) => x.code === "text-overflow")!;
    expect(f.element!.startsWith("text#label")).toBe(true);
    expect(f.message).toContain("rect#card");
  });

  it("element flying outside the viewBox mid-animation", async () => {
    const r = await inspected("fly_out.svg");
    const f = r.findings.find((x) => x.code === "outside-bounds")!;
    expect(f.element).toBe("rect#box");
    expect(f.times).not.toContain(0);
    expect(f.times!.some((t) => t >= 0.8 && t <= 1.2)).toBe(true);
    expect(r.report.loop.seamless).toBe(true);
  });

  it("non-seamless loop", async () => {
    const r = await inspected("non_seamless.svg");
    expect(codes(r)).toContain("non-seamless-loop");
    const { loop } = r.report;
    expect(loop.checked).toBe(true);
    expect(loop.seamless).toBe(false);
    expect(loop.seam_ratio!).toBeGreaterThan(loop.step_ratio!);
  });

  it("CSS rotation without transform-box", async () => {
    const r = await inspected("rotate_no_box.svg");
    expect(codes(r, "static")).toContain("transform-without-box");
    expect(codes(r, "render")).toContain("svg-transform-box");
    expect(codes(r)).toContain("outside-bounds");
  });

  it("rAF canvas animation is JS-driven", async () => {
    const r = await inspected("raf_canvas.html");
    expect(r.report.duration.method).toBe("fallback");
    expect(codes(r)).toContain("js-driven-motion");
    expect(r.report.frames.slice(1).some((f) => f.changed_ratio > 0)).toBe(true);
  });

  it("rAF canvas position matches virtual time", async () => {
    const r = await inspected("raf_canvas.html", { frames: 3, duration: 2, at: 1, heatFrames: 0 });
    const full = decode(r.images.full);
    // The dot is at x = 320 + 220*cos(pi*t): at t=1.0s it is leftmost, centred on x=100.
    const green: number[] = [];
    for (let x = 0; x < 640; x++) if (full.data[(180 * full.width + x) * 4 + 1] > 150) green.push(x);
    expect(green.length).toBeGreaterThan(0);
    expect(Math.abs((green[0] + green[green.length - 1]) / 2 - 100)).toBeLessThanOrEqual(4);
  });

  it("clean fixture has no warnings", async () => {
    const r = await inspected("pipeline.svg");
    expect(r.findings.filter((f) => f.severity !== "info")).toEqual([]);
    expect(r.report.duration.seconds).toBeCloseTo(4);
    expect(r.report.loop.seamless).toBe(true);
    expect(r.report.elements.map((e) => e.element)).toContain("rect.pl-spin[4]");
  });

  it("Web Animation with alternate direction", async () => {
    const r = await inspected("waapi.html");
    expect(new Set(r.report.duration.animations.map((a) => a.kind))).toEqual(new Set(["web-animation"]));
    expect(r.report.duration.seconds).toBeCloseTo(3);
    expect(r.report.loop.seamless).toBe(true);
  });

  it("finite animation", async () => {
    const r = await inspected("finite.svg");
    expect(r.report.duration.looping).toBe(false);
    expect(r.report.duration.seconds).toBeCloseTo(2);
    expect(r.report.loop.checked).toBe(false);
    const track = r.report.elements.find((e) => e.element === "rect#bar")!;
    const first = track.boxes[0];
    const last = track.boxes[track.boxes.length - 1];
    expect(first === null || first[2] < 1).toBe(true);
    expect(last![2]).toBeGreaterThan(250);
  });

  it("HTML text overflow", async () => {
    const r = await inspected("html_overflow.html");
    const f = r.findings.find((x) => x.code === "text-overflow")!;
    expect(f.element!.startsWith("div.badge")).toBe(true);
  });

  it("sheet geometry and last tile time", async () => {
    const r = await inspected("fly_out.svg");
    const sheet = decode(r.images.sheet);
    expect(r.report.times).toHaveLength(12);
    expect(sheet.width).toBe(1494);
    expect(sheet.width).toBeLessThanOrEqual(1568);
    expect(r.report.times[11]).toBeCloseTo(2 - 1 / 60, 3);
  });

  it("custom frames and columns", async () => {
    const r = await inspected("fly_out.svg", { frames: 4, columns: 4, tile: 100, heatFrames: 0 });
    const sheet = decode(r.images.sheet);
    expect(r.report.times).toHaveLength(4);
    expect(sheet.width).toBe(Math.max(2 * 12 + 4 * 102 + 3 * 12, 560));
    expect(sheet.height).toBe(66 + 2 * 12 + 50 + 2 + 34);
  });

  it("writes report.json and images with out", async () => {
    const out = tmp();
    const r = await inspect(fixture("parked_dot.svg"), { browser: browser(), out, keepFrames: true, frames: 4 });
    expect(r.files!.sheet).toBe(join(out, "sheet.png"));
    const data = JSON.parse(readFileSync(join(out, "report.json"), "utf8"));
    expect(data.duration.seconds).toBeCloseTo(3);
    expect(data.frames).toHaveLength(4);
    expect(data.frames[1].path).toBe(join(out, "frames", "frame_001.png"));
    expect(readFileSync(join(out, "frames", "frame_003.png")).equals(r.images.frames![3])).toBe(true);
    const full = decode(readFileSync(join(out, "full.png")));
    expect([full.width, full.height]).toEqual([400, 200]);
  });

  it("is deterministic (same input, same PNG bytes)", async () => {
    const a = await inspect(fixture("pipeline.svg"), { browser: browser() });
    const b = await inspect(fixture("pipeline.svg"), { browser: browser() });
    for (const key of ["full", "sheet", "heatmap"] as const) {
      expect(a.images[key].equals(b.images[key]), key).toBe(true);
    }
    expect(JSON.stringify(a.report)).toBe(JSON.stringify(b.report));
  });

  it("markup snippets and explicit size", async () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><title>x</title>' +
      '<rect width="100" height="50" fill="red"/></svg>';
    const r = await inspect(svg, { browser: browser(), size: [200, 100], frames: 2, heatFrames: 0 });
    expect(r.report.kind).toBe("svg");
    expect(r.report.source).toBe("<snippet>");
    expect(r.report.viewport).toEqual([200, 100]);
    expect(codes(r)).toContain("no-motion");
    const full = decode(r.images.full);
    expect([full.width, full.height]).toEqual([200, 100]);
    expect(r.files).toBeNull();
  });

  it("auto-scales small SVGs", async () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><title>i</title><circle cx="12" cy="12" r="8"/></svg>';
    const r = await inspect(svg, { browser: browser(), frames: 2, heatFrames: 0 });
    expect(r.report.device_scale_factor).toBeGreaterThan(1);
    expect(decode(r.images.full).width).toBe(Math.round(24 * r.report.device_scale_factor));
  });

  it("blocks the network for untrusted markup", async () => {
    const html =
      '<img src="https://example.invalid/x.png"><div style="width:40px;height:40px;background:red"></div>';
    const r = await inspect(html, { browser: browser(), frames: 2, heatFrames: 0, blockNetwork: true });
    expect(r.report.kind).toBe("html");
    expect(r.report.console_errors.join(" ")).toMatch(/ERR_BLOCKED_BY_CLIENT|Failed to load/);
  });

  it("blockNetwork stops fetch, images and WebSockets (counted by a local server)", async () => {
    const hits: string[] = [];
    let page = "";
    const server = createServer((req, res) => {
      if (req.url === "/page.html") {
        res.setHeader("content-type", "text/html");
        res.end(page);
        return;
      }
      hits.push(`http ${req.url}`);
      res.end("ok");
    });
    server.on("upgrade", (req, socket) => {
      hits.push(`ws ${req.url}`);
      socket.destroy();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    page =
      `<!DOCTYPE html><img src="/img.png"><script>fetch("/fetch").catch(() => {});` +
      `new WebSocket("ws://127.0.0.1:${port}/ws");</script>`;
    const url = `http://127.0.0.1:${port}/page.html`;
    try {
      const opts = { browser: browser(), frames: 2, heatFrames: 0, duration: 0.5 };
      await inspect(url, { ...opts, blockNetwork: true }); // the page itself still loads
      expect(hits).toEqual([]);
      await inspect(url, opts); // control: without blocking, all three reach the server
      expect(new Set(hits)).toEqual(new Set(["http /img.png", "http /fetch", "ws /ws"]));
    } finally {
      server.close();
    }
  });

  it("summary has the Python CLI format", async () => {
    const r = await inspected("non_seamless.svg");
    const lines = r.summary().split("\n");
    expect(lines[0]).toMatch(/^framesheet: .*non_seamless\.svg \(svg, 400x200 @1x\)$/);
    expect(lines[1]).toBe("duration: 3s detected: loop period 3s (1 animation(s): css-animation) [looping]");
    expect(lines).toContain("images:");
  });

  it("validates options", async () => {
    await expect(inspect(fixture("finite.svg"), { browser: browser(), frames: 1 })).rejects.toThrow(/frames/);
    await expect(inspect(fixture("missing.svg"), { browser: browser() })).rejects.toThrow(/Input not found/);
  });
});
