/**
 * `framesheet/test`: visual regression of animations in a `@playwright/test` suite.
 *
 * ```ts
 * import { test } from "@playwright/test";
 * import { expectAnimation } from "framesheet/test";
 *
 * test("mind map opens smoothly", async ({ page }) => {
 *   await page.goto("/mindmap");
 *   await expectAnimation(page.locator("#mindmap"), "mindmap-open", { frames: 8 });
 * });
 * ```
 */

import { expect, type Locator, type Page, test } from "@playwright/test";
import { type Inspection, type InspectPageOptions, inspectPage } from "./inspect.js";
import type { Finding, Severity } from "./models.js";

export { LAUNCH_ARGS, prepare } from "./inspect.js";

export interface ExpectAnimationOptions extends Omit<InspectPageOptions, "locator" | "out"> {
  /** Allowed share of differing pixels in the sheet (Playwright `maxDiffPixelRatio`). */
  maxDiffPixelRatio?: number;
  /** Allowed number of differing pixels (Playwright `maxDiffPixels`). */
  maxDiffPixels?: number;
  /** Per-pixel colour distance threshold 0-1 (Playwright `threshold`, default 0.2). */
  threshold?: number;
  /** Also compare the motion heatmap against `<name>-heatmap.png`. Default false. */
  heatmap?: boolean;
  /**
   * Fail on findings of this severity or worse: `"error"` (default), `"warning"`, or
   * `false` to only compare images.
   */
  failOn?: Exclude<Severity, "info"> | false;
  /** Finding codes to ignore for `failOn` (e.g. `["console-error"]`). */
  ignore?: string[];
  /** Attach sheet/heatmap/full/report to the test report. Default true. */
  attach?: boolean;
  /** Compare against the stored baseline. Default true; `false` only checks findings. */
  snapshot?: boolean;
}

function isPage(target: Page | Locator): target is Page {
  return typeof (target as Page).goto === "function";
}

function describe(findings: Finding[]): string {
  return findings.map((f) => `${f.severity} ${f.code}: ${f.message}`).join("\n");
}

/**
 * Build the contact sheet of an animation (whole page or one component) and compare it
 * with the stored baseline `<name>.png` via Playwright's `toMatchSnapshot` (so
 * `--update-snapshots`, per-platform snapshot names and diff images work as usual).
 * Also fails on error findings unless `failOn: false`. Returns the inspection.
 */
export async function expectAnimation(
  target: Page | Locator,
  name: string,
  options: ExpectAnimationOptions = {},
): Promise<Inspection> {
  const page = isPage(target) ? target : target.page();
  const locator = isPage(target) ? undefined : target;
  const {
    maxDiffPixelRatio,
    maxDiffPixels,
    threshold,
    heatmap,
    failOn = "error",
    ignore = [],
    attach = true,
    snapshot = true,
    ...rest
  } = options;
  const result = await inspectPage(page, { ...rest, locator, title: rest.title ?? name });
  const base = name.replace(/\.png$/i, "");
  if (attach) {
    const info = test.info();
    await info.attach(`${base}-sheet.png`, { body: result.images.sheet, contentType: "image/png" });
    await info.attach(`${base}-heatmap.png`, { body: result.images.heatmap, contentType: "image/png" });
    await info.attach(`${base}-full.png`, { body: result.images.full, contentType: "image/png" });
    await info.attach(`${base}-report.json`, {
      body: JSON.stringify(result.report, null, 2),
      contentType: "application/json",
    });
  }
  const compare = Object.fromEntries(
    Object.entries({ maxDiffPixelRatio, maxDiffPixels, threshold }).filter(([, v]) => v !== undefined),
  );
  if (snapshot) {
    expect(result.images.sheet).toMatchSnapshot(`${base}.png`, compare);
    if (heatmap) expect(result.images.heatmap).toMatchSnapshot(`${base}-heatmap.png`, compare);
  }
  if (failOn) {
    const worst = failOn === "warning" ? ["error", "warning"] : ["error"];
    const bad = result.findings.filter((f) => worst.includes(f.severity) && !ignore.includes(f.code));
    expect(bad, `framesheet findings for '${base}':\n${describe(bad)}\n\n${result.summary()}`).toEqual([]);
  }
  return result;
}
