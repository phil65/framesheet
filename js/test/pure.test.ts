// Pure logic: Python-compatible formatting, duration detection, layout (no browser).
import { describe, expect, it } from "vitest";
import { autoTile, defaultColumns, sheetLayout } from "../src/compose.js";
import type { AnimationTiming } from "../src/models.js";
import { fixed, g, pct, pyRound } from "../src/pyfmt.js";
import { looksLikeSvg, parseSize } from "../src/sources.js";
import { detectDuration, FALLBACK_SECONDS, sampleTimes } from "../src/timing.js";

function anim(
  duration: number,
  { start = 0, iterations = null as number | null, alternate = false } = {},
): AnimationTiming {
  return {
    kind: "css-animation",
    target: null,
    name: null,
    start,
    duration,
    iterations,
    direction: alternate ? "alternate" : "normal",
    period: duration * (alternate ? 2 : 1),
    end: iterations === null ? null : start + duration * iterations,
    transform_box: null,
  };
}

describe("python formatting", () => {
  it("rounds half to even on the exact value", () => {
    expect(pyRound(0.125, 2)).toBe(0.12);
    expect(pyRound(0.375, 2)).toBe(0.38);
    expect(pyRound(2.5)).toBe(2);
    expect(pyRound(3.5)).toBe(4);
    expect(pyRound(2.675, 2)).toBe(2.67); // binary value is below the tie
    expect(pyRound(1 / 3, 4)).toBe(0.3333);
    expect(pyRound(-0.0001, 2)).toBe(0);
  });
  it("formats like f-strings", () => {
    expect(fixed(0.125, 2)).toBe("0.12");
    expect(fixed(2.9833, 2)).toBe("2.98");
    expect(g(3)).toBe("3");
    expect(g(2.5)).toBe("2.5");
    expect(g(0.016667)).toBe("0.016667");
    expect(g(1 / 60)).toBe("0.0166667");
    expect(g(60)).toBe("60");
    expect(g(1234567)).toBe("1.23457e+06");
    expect(g(0.00001)).toBe("1e-05");
    expect(pct(0.0037, 2)).toBe("0.37%");
    expect(pct(0.028, 1)).toBe("2.8%");
  });
});

describe("duration detection (port of tests/test_timing.py)", () => {
  it("falls back", () => {
    const info = detectDuration([]);
    expect(info.method).toBe("fallback");
    expect(info.seconds).toBe(FALLBACK_SECONDS);
  });
  it("override wins", () => {
    const info = detectDuration([anim(2)], 5);
    expect([info.method, info.seconds]).toEqual(["override", 5]);
  });
  it("uses the LCM of periods", () => expect(detectDuration([anim(2), anim(3)]).seconds).toBeCloseTo(6));
  it("uses the longest of incommensurate periods", () => {
    const info = detectDuration([anim(1.7), anim(2.3)]);
    expect(info.seconds).toBeCloseTo(2.3);
    expect(info.detail).toContain("longest");
  });
  it("doubles alternate periods", () => expect(detectDuration([anim(1.5, { alternate: true })]).seconds).toBeCloseTo(3));
  it("adds positive warm-up only", () => {
    expect(detectDuration([anim(2, { start: 1 })]).seconds).toBeCloseTo(3);
    expect(detectDuration([anim(2, { start: -0.5 })]).seconds).toBeCloseTo(2);
  });
  it("uses finite end", () => {
    const info = detectDuration([anim(1.5, { start: 0.5, iterations: 2 })]);
    expect(info.seconds).toBeCloseTo(3.5);
    expect(info.looping).toBe(false);
  });
  it("caps", () => expect(detectDuration([anim(100, { iterations: 1 })]).seconds).toBe(60));
  it("samples one frame before the end", () => {
    const times = sampleTimes(3, 4);
    expect(times.slice(0, 3)).toEqual([0, 1, 2]);
    expect(times[3]).toBeCloseTo(3 - 1 / 60, 4);
  });
  it("detail text matches Python", () => {
    expect(detectDuration([{ ...anim(2), kind: "smil", start: 1 }]).detail).toBe(
      "loop period 2s; + 1s positive begin/delay before the first loop (1 animation(s): smil)",
    );
  });
});

describe("sources and layout", () => {
  it("parses sizes and sniffs svg", () => {
    expect(parseSize("640x360")).toEqual([640, 360]);
    expect(() => parseSize("big")).toThrow(/WIDTHxHEIGHT/);
    expect(looksLikeSvg('<?xml version="1.0"?>\n<!-- c -->\n<svg/>')).toBe(true);
    expect(looksLikeSvg("<div>hi</div>")).toBe(false);
  });
  it("lays out a sheet like compose.py", () => {
    // Same numbers as tests/test_inspect.py::test_sheet_geometry (fly_out.svg, 400x200).
    const cols = defaultColumns(12, 2);
    const tile = autoTile(cols);
    const layout = sheetLayout([400, 200], 12, {});
    const rows = Math.ceil(12 / cols);
    expect(layout.width).toBe(2 * 12 + cols * (tile + 2) + (cols - 1) * 12);
    expect(layout.height).toBe(66 + 2 * 12 + rows * (Math.round(tile / 2) + 2 + 34) + (rows - 1) * 12);
    expect(layout.width).toBeLessThanOrEqual(1568);
    // tests/test_inspect.py::test_custom_frames_and_columns
    const custom = sheetLayout([400, 200], 4, { columns: 4, tile: 100 });
    expect(custom.width).toBe(Math.max(2 * 12 + 4 * 102 + 3 * 12, 560));
    expect(custom.height).toBe(66 + 2 * 12 + 50 + 2 + 34);
  });
});
