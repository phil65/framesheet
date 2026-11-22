// Visual regression of animated components with framesheet/test.
//
// Baselines live in expect-animation.spec.ts-snapshots/ (per platform, Playwright's
// usual naming). Update them with `npm run test:e2e -- --update-snapshots`.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";
import { expectAnimation, prepare } from "framesheet/test";

const here = dirname(fileURLToPath(import.meta.url));
const page = (name: string, query = "") => `${pathToFileURL(join(here, "fixtures", name)).href}${query}`;

test("mind map opens: contact sheet matches the baseline", async ({ page: p }) => {
  await p.goto(page("mindmap.html"));
  const result = await expectAnimation(p.locator("#mindmap"), "mindmap-open", {
    frames: 8,
    // Start the CSS animations from their first frame on frozen time.
    trigger: () => p.locator("#toggle").click(),
    maxDiffPixelRatio: 0.01,
  });
  expect(result.report.duration.seconds).toBeCloseTo(1.1); // last leaf: 0.7 s delay + 0.4 s
  expect(result.report.duration.looping).toBe(false);
  expect(result.report.elements.length).toBeGreaterThanOrEqual(8);
});

test("a regression in the animation fails the comparison", async ({ page: p }) => {
  const info = test.info();
  test.skip(info.config.updateSnapshots === "all" || info.config.updateSnapshots === "changed", "updating baselines");
  test.skip(!existsSync(info.snapshotPath("mindmap-open.png")), "baseline not recorded yet");
  await p.goto(page("mindmap.html", "?variant=broken"));
  await expect(
    expectAnimation(p.locator("#mindmap"), "mindmap-open", {
      frames: 8,
      trigger: () => p.locator("#toggle").click(),
      maxDiffPixelRatio: 0.01,
      attach: false,
    }),
  ).rejects.toThrow(/toMatchSnapshot|pixels/i);
});

test("JS-driven drawing, frozen from navigation: prepare(page, { paused: true })", async ({ page: p }) => {
  await prepare(p, { paused: true }); // before goto
  await p.goto(page("sketch.html"));
  const result = await expectAnimation(p.locator("#sketch"), "sketch-draw", {
    frames: 6,
    duration: 1.5, // JS-driven: no declarative timing to detect
    maxDiffPixelRatio: 0.01,
  });
  expect(result.report.duration.method).toBe("override");
  expect(result.report.frames.slice(1).every((f) => f.changed_ratio > 0)).toBe(true);
});

test("JS-driven drawing on a running app: prepare(page) keeps real time until inspected", async ({ page: p }) => {
  await prepare(p);
  await p.goto(page("sketch.html"));
  await p.waitForTimeout(500); // the app runs normally; the stroke is partly drawn
  const result = await expectAnimation(p.locator("#sketch"), "sketch-running", {
    frames: 4,
    duration: 1.5,
    snapshot: false, // where the stroke is depends on wall time before the inspection
  });
  expect(result.report.frames.length).toBe(4);
  // The fake clock runs on afterwards.
  const t0 = await p.evaluate(() => Date.now());
  await p.waitForTimeout(100);
  expect(await p.evaluate(() => Date.now())).toBeGreaterThan(t0);
});

test("error findings fail the assertion (static checks on the component)", async ({ page: p }) => {
  await p.setContent(
    `<svg id="icon" viewBox="0 0 40 40" width="160" height="160"><circle id="a" cx="20" cy="20" r="10"/>` +
      `<circle id="a" cx="5" cy="5" r="3"/><use href="#missing"/></svg>`,
  );
  await expect(
    expectAnimation(p.locator("#icon"), "icon", { frames: 2, heatFrames: 0, staticChecks: true, snapshot: false }),
  ).rejects.toThrow(/duplicate-id[\s\S]*broken-ref|broken-ref[\s\S]*duplicate-id/);
});
