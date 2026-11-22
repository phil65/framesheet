// Schema parity with the Python implementation.
//
// - Every JS report validates against ../schema/report.schema.json (generated from the
//   pydantic models; finding codes are an enum there).
// - Each JS report is compared with the golden Python report of the same fixture
//   (../schema/golden, or FRAMESHEET_GOLDEN_DIR: CI regenerates them with Python on the
//   same machine and then compares strictly, number for number).
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { inspect, type Report } from "../src/index.js";
import { FIXTURES, GOLDEN_DIR, SCHEMA_PATH, useBrowser } from "./helpers.js";

/** Same options as scripts/sync_schema.py GOLDEN_OPTIONS. */
const GOLDEN_OPTIONS = { frames: 12, heatFrames: 48 };
/** Strict when the goldens were produced on this machine (CI), tolerant for committed ones. */
const STRICT = Boolean(process.env.FRAMESHEET_GOLDEN_DIR);
const browser = useBrowser();
const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: false });
ajv.addFormat("path", true);
const validate = ajv.compile(schema);

const goldens = readdirSync(GOLDEN_DIR)
  .filter((f) => f.endsWith(".json"))
  .sort();
const fixtureFor = (stem: string) => readdirSync(FIXTURES).find((f) => f.replace(/\.[^.]+$/, "") === stem)!;

/** Key structure of a JSON value (objects: sorted keys; arrays: element shapes). */
function shape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shape);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, shape((value as Record<string, unknown>)[k])]),
    );
  }
  return value === null ? "null" : typeof value;
}

/** Numbers in render messages depend on pixels; compare them only in strict mode. */
const scrub = (message: string) => (STRICT ? message : message.replace(/-?\d+(\.\d+)?/g, "#"));

function close(a: number | null, b: number | null, tol: number): boolean {
  if (a === null || b === null) return a === b;
  return Math.abs(a - b) <= tol;
}

describe("report schema", () => {
  it("has goldens for the fixtures", () => {
    expect(goldens.length).toBeGreaterThanOrEqual(10);
  });

  it("rejects unknown fields and finding codes", () => {
    const golden = JSON.parse(readFileSync(join(GOLDEN_DIR, goldens[0]), "utf8"));
    expect(validate(golden), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...golden, extra: 1 })).toBe(false);
    const bad = { ...golden, findings: [{ ...golden.findings[0], code: "made-up-code" }] };
    expect(validate(bad)).toBe(false);
  });
});

describe.each(goldens)("parity with Python: %s", (file) => {
  const golden: Report = JSON.parse(readFileSync(join(GOLDEN_DIR, file), "utf8"));
  const name = fixtureFor(basename(file, ".json"));
  let report: Report;

  it("validates against the shared schema", async () => {
    const result = await inspect(join(FIXTURES, name), { browser: browser(), ...GOLDEN_OPTIONS });
    report = result.report;
    expect(validate(report), JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  it("has the same structure and the same findings", () => {
    const normalised = {
      ...report,
      source: basename(report.source),
    };
    // Null-vs-value differences are allowed only where pixels decide (boxes).
    expect(Object.keys(normalised)).toEqual(Object.keys(golden));
    expect(shape(normalised.duration)).toEqual(shape(golden.duration));
    expect(shape(normalised.findings.map((f) => Object.keys(f)))).toEqual(shape(golden.findings.map((f) => Object.keys(f))));
    expect(normalised.source).toBe(golden.source);
    expect(report.kind).toBe(golden.kind);
    expect(report.viewport).toEqual(golden.viewport);
    expect(report.device_scale_factor).toBe(golden.device_scale_factor);
    expect(report.times).toEqual(golden.times);
    expect(report.full_at).toBe(golden.full_at);
    expect(report.duration).toEqual(golden.duration);
    expect(report.canvas.every((v, i) => close(v, golden.canvas[i], 0.01))).toBe(true);
    const simple = (r: Report) =>
      r.findings.map((f) => ({ ...f, message: f.check === "static" ? f.message : scrub(f.message) }));
    expect(simple(report)).toEqual(simple(golden));
    expect(report.console_errors).toEqual(golden.console_errors);
  });

  it("has the same metrics, loop verdict and element tracks", () => {
    const tol = STRICT ? 1e-9 : 0.01;
    expect(report.frames.map((f) => [f.index, f.t])).toEqual(golden.frames.map((f) => [f.index, f.t]));
    report.frames.forEach((f, i) => {
      expect(close(f.changed_ratio, golden.frames[i].changed_ratio, tol), `frame ${i}`).toBe(true);
    });
    if (STRICT) expect(report.frames).toEqual(golden.frames);
    expect(report.loop.checked).toBe(golden.loop.checked);
    expect(report.loop.seamless).toBe(golden.loop.seamless);
    expect(close(report.loop.seam_ratio, golden.loop.seam_ratio, tol)).toBe(true);
    expect(close(report.loop.step_ratio, golden.loop.step_ratio, tol)).toBe(true);
    if (STRICT) expect(report.loop).toEqual(golden.loop);
    expect(report.elements.map((e) => [e.element, e.animated_by, e.units])).toEqual(
      golden.elements.map((e) => [e.element, e.animated_by, e.units]),
    );
    report.elements.forEach((e, i) => {
      e.boxes.forEach((box, k) => {
        const other = golden.elements[i].boxes[k];
        expect(box === null, `${e.element} frame ${k}`).toBe(other === null);
        if (box && other) expect(box.every((v, j) => close(v, other[j], STRICT ? 1e-6 : 2))).toBe(true);
      });
    });
  });
});
