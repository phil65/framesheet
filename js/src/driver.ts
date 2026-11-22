/**
 * Frame-accurate time control on one page (or iframe), port of render.py's Session.
 *
 * Time is virtual. Three mechanisms are driven to the same target time `t`:
 *
 * - JavaScript clocks (`Date`, `performance.now`, timers, `requestAnimationFrame`) run on
 *   Playwright's fake clock if it was installed before navigation (`inspect()` does that;
 *   for your own pages call `prepare(page)` before `goto`). Moving to `t` calls
 *   `page.clock.runFor(delta)`, which fires every due timer and rAF callback in order.
 * - SMIL: every outermost `<svg>` gets `pauseAnimations()` + `setCurrentTime(t)`.
 * - CSS animations/transitions and Web Animations: `document.getAnimations()` are paused
 *   and `currentTime` is set to `t` (relative to when the animation was first seen).
 *
 * The last two work on any page, at any time; they live in the shared runtime.js.
 */

import type { Frame, Page } from "playwright-core";
import type { FrameGeometry, GeometryEntry } from "./analysis.js";
import { RUNTIME_JS } from "./generated/assets.js";
import { pyRound } from "./pyfmt.js";

/** One fake animation frame, so rAF-driven content has painted at t=0. */
export const FIRST_FRAME_MS = 17;

export interface Clip {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Snapshot extends FrameGeometry {
  png: Buffer;
}

type FS = {
  __framesheet: {
    seek(t: number): boolean;
    scope(el: Element | null): boolean;
  };
};

export class Driver {
  nowMs = 0;

  constructor(
    readonly page: Page,
    readonly frame: Frame,
    /** True if Playwright's fake clock is installed and paused (JS time is controlled). */
    readonly clockControlled: boolean,
    public clip: Clip | null = null,
  ) {}

  /** Evaluate an expression string in the inspected frame. */
  js<T = unknown>(expression: string): Promise<T> {
    return this.frame.evaluate(expression) as Promise<T>;
  }

  /** (Re-)install the shared runtime: fresh caches for every inspection. */
  async inject(): Promise<void> {
    await this.frame.evaluate("delete window.__framesheet");
    await this.frame.evaluate(RUNTIME_JS);
  }

  /** Limit measuring to an element's subtree (null = whole document). */
  async scope(handle: import("playwright-core").ElementHandle<Element> | null): Promise<void> {
    if (handle) await handle.evaluate((el) => (window as unknown as FS).__framesheet.scope(el));
    else await this.frame.evaluate(() => (window as unknown as FS).__framesheet.scope(null));
  }

  /** Wait for fonts/images, let one fake frame run, then seek to t=0. */
  async start(): Promise<void> {
    await this.js("window.__framesheet.ready()");
    // JS clocks are therefore ~17 ms ahead of SMIL/CSS time (same as Python).
    if (this.clockControlled) await this.page.clock.runFor(FIRST_FRAME_MS);
    await this.seek(0);
  }

  /** Move all clocks to virtual time `t` (seconds). Time only moves forward. */
  async seek(t: number): Promise<void> {
    const target = pyRound(t * 1000);
    if (target < this.nowMs) throw new Error(`Cannot seek backwards (${t}s < ${this.nowMs / 1000}s)`);
    if (target > this.nowMs) {
      if (this.clockControlled) await this.page.clock.runFor(target - this.nowMs);
      this.nowMs = target;
    }
    await this.frame.evaluate((time) => (window as unknown as FS).__framesheet.seek(time), t);
    await this.js("window.__framesheet.settle()");
  }

  /** Pixels only, at virtual time `t`. */
  async screenshot(t: number): Promise<Buffer> {
    await this.seek(t);
    return this.page.screenshot({
      type: "png",
      caret: "hide",
      animations: "allow",
      scale: "device",
      ...(this.clip ? { clip: this.clip } : {}),
    });
  }

  /** Pixels plus element geometry at virtual time `t`. */
  async snapshot(t: number, overflow: boolean): Promise<Snapshot> {
    const png = await this.screenshot(t);
    const geometry = await this.js<GeometryEntry[]>("window.__framesheet.measure()");
    const over = overflow ? await this.js<[number, number, number][]>("window.__framesheet.htmlOverflow()") : [];
    return { t, png, geometry, overflow: over };
  }

  /** Hand the page back: unpause what seek() paused (inspectPage on a running app). */
  async resume(): Promise<void> {
    await this.js("window.__framesheet && window.__framesheet.resume()").catch(() => undefined);
  }
}
