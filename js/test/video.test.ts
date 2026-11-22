// Video input: container probing, marks validation, overlay/timeline layout parity with
// Python, time planning, and end-to-end inspections of the committed video fixtures.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  activeLabels,
  type Inspection,
  type InspectOptions,
  inspect,
  type Marks,
  MarksError,
  parseMarks,
  planTimes,
  probe,
  tileOps,
  timelineOps,
} from "../src/index.js";
import { bandText, type Issue } from "../src/marks.js";
import { decode } from "../src/pixels.js";
import { fixture, GOLDEN_DIR, REPO_ROOT, useBrowser } from "./helpers.js";

const browser = useBrowser();
const cache = new Map<string, Promise<Inspection>>();
function inspected(name: string, options: InspectOptions = {}): Promise<Inspection> {
  const key = `${name} ${JSON.stringify(options)}`;
  if (!cache.has(key)) cache.set(key, inspect(fixture(name), { browser: browser(), ...options }));
  return cache.get(key)!;
}
const codes = (r: Inspection) => new Set(r.findings.map((f) => f.code));
const MARKS = fixture("square.marks.json");

describe("container probing (= media.py)", () => {
  it("reads webm, mp4 and gif headers", () => {
    expect(probe(readFileSync(fixture("square.webm")))).toEqual({
      container: "webm",
      codec: "vp9",
      width: 320,
      height: 180,
      fps: 10,
      frameCount: 60,
      duration: 6,
    });
    expect(probe(readFileSync(fixture("square_h264.mp4")))).toMatchObject({
      container: "mp4",
      codec: "h264",
      width: 320,
      height: 180,
      fps: 10,
      frameCount: 60,
      duration: 6,
    });
    expect(probe(readFileSync(fixture("square_gif.gif")))).toMatchObject({ container: "gif", width: 160, height: 90 });
    expect(() => probe(Buffer.from("<svg/>"))).toThrow(/Not a supported video/);
  });
});

describe("marks validation (= models.Marks)", () => {
  const cases = JSON.parse(readFileSync(fixture("marks_cases.json"), "utf8")) as { valid: unknown[]; invalid: unknown[] };
  const schema = JSON.parse(readFileSync(join(REPO_ROOT, "schema", "marks.schema.json"), "utf8"));
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);

  it.each(cases.valid.map((c, i) => [i, c]))("accepts valid case %i", (_i, c) => {
    expect(() => parseMarks(c)).not.toThrow();
    expect(validate(c), JSON.stringify(validate.errors)).toBe(true);
  });

  it.each(cases.invalid.map((c, i) => [i, c]))("rejects invalid case %i", (_i, c) => {
    expect(() => parseMarks(c)).toThrow(MarksError);
  });

  it("fills defaults like pydantic", () => {
    const m = parseMarks({ points: [{ t: 1, x: 0.5, y: 0.5 }] });
    expect(m).toEqual({ frame: null, points: [{ t: 1, x: 0.5, y: 0.5, label: null, kind: null, duration: 0 }], regions: [], spans: [] });
  });
});

describe("overlay and timeline layout (parity with Python ops)", () => {
  const golden = JSON.parse(readFileSync(join(GOLDEN_DIR, "layout", "marks_layout.json"), "utf8")) as {
    marks: Record<string, unknown>;
    cases: Record<string, unknown>[];
  };
  const marks: Record<string, Marks> = Object.fromEntries(Object.entries(golden.marks).map(([k, v]) => [k, parseMarks(v)]));

  it("has cases", () => expect(golden.cases.length).toBeGreaterThan(20));

  it.each(golden.cases.map((c, i) => [i, c.type, c]))("case %i (%s) produces the same ops", (_i, _type, c) => {
    const m = c.marks === null ? null : marks[c.marks as string];
    if (c.type === "tile") {
      const window = c.window as [number, number];
      const ops = tileOps(m!, c.t as number, window, c.last as boolean, {
        size: c.size as [number, number],
        viewport: c.viewport as [number, number],
        content: c.content as [number, number, number, number],
      });
      expect(ops).toEqual(c.ops);
      expect(activeLabels(m!, c.t as number, window, c.last as boolean)).toEqual(c.labels);
      expect(bandText(m!, c.t as number)).toEqual(c.band);
    } else {
      const [height, ops] = timelineOps(c.width as number, c.start as number, c.end as number, c.times as number[], {
        marks: m,
        activity: c.activity as [number, number][] | null,
        issues: c.issues as Issue[] | null,
      });
      expect(height).toBe(c.height);
      expect(ops).toEqual(c.ops);
    }
  });
});

describe("planTimes (= video.plan_times)", () => {
  it("spreads tiles evenly, the last at the range end", () => {
    expect(planTimes(6, { frames: 4 })).toEqual([0, 6, [0, 2, 4, 6], "evenly spaced"]);
    expect(planTimes(6, { frames: 3, start: 1, end: 2 })[2]).toEqual([1, 1.5, 2]);
  });

  it("supports every, explicit times and times from marks", () => {
    expect(planTimes(6.5, { every: 2 })[2]).toEqual([0, 2, 4, 6, 6.5]);
    expect(planTimes(6, { times: [3, 1, 1] })[2]).toEqual([1, 3]);
    const m = parseMarks(JSON.parse(readFileSync(MARKS, "utf8")));
    expect(planTimes(6, { times: "marks", marks: m })).toEqual([0, 6, [1, 1.5, 1.6, 4.25], "times from marks"]);
  });

  it("rejects bad ranges", () => {
    expect(() => planTimes(6, { start: 5, end: 4 })).toThrow(/Invalid range/);
    expect(() => planTimes(6, { times: [7] })).toThrow(/outside/);
    expect(() => planTimes(600, { every: 1 })).toThrow(/max 100/);
  });
});

describe("inspect() on videos", () => {
  it("finds the static stretch, the black frames, the cuts and the caption overlap", async () => {
    const r = await inspected("square.webm", { marks: MARKS });
    expect(r.report.kind).toBe("video");
    expect(codes(r)).toEqual(new Set(["video-static-stretch", "video-black-frames", "video-abrupt-cut", "video-mark-overlap"]));
    const v = r.report.video!;
    expect([v.container, v.codec, v.decoder, v.width, v.height, v.fps, v.frame_count]).toEqual(["webm", "vp9", "video", 320, 180, 10, 60]);
    const stretch = r.findings.find((f) => f.code === "video-static-stretch")!;
    expect(stretch.times![0]).toBeCloseTo(2, 1);
    expect(stretch.times![1]).toBeGreaterThan(4.2);
    const black = r.findings.find((f) => f.code === "video-black-frames")!;
    expect(black.times!.every((t) => t >= 4.5 && t < 4.8)).toBe(true);
    expect(v.tiles.map((t) => t.duplicate)).toContain(true);
    expect(v.tiles[2].marks).toContain("click #save @1.00s");
    expect(r.summary()).toContain("video: webm vp9 320x180 10fps, 60 frames");
  });

  it("decodes animated GIFs with ImageDecoder", async () => {
    const r = await inspected("square_gif.gif", { frames: 6 });
    const v = r.report.video!;
    expect([v.decoder, v.frame_count, v.media_duration]).toEqual(["image-decoder", 60, 6]);
    expect(codes(r)).toContain("video-black-frames");
  });

  it("samples a range at explicit times", async () => {
    const r = await inspected("square.webm", { start: 1, end: 3, every: 0.5, heatFrames: 8 });
    expect(r.report.times).toEqual([1, 1.5, 2, 2.5, 3]);
    expect(r.report.video!.tiles.map((t) => t.media_time)).toEqual([1, 1.5, 2, 2.5, 3]);
    expect(r.report.full_at).toBe(1);
  });

  it("is deterministic and draws the timeline below the grid", async () => {
    const out = mkdtempSync(join(tmpdir(), "framesheet-js-video-"));
    const a = await inspect(fixture("square.webm"), { browser: browser(), marks: MARKS, out });
    const b = await inspected("square.webm", { marks: MARKS });
    expect(a.images.sheet.equals(b.images.sheet)).toBe(true);
    expect(a.images.heatmap.equals(b.images.heatmap)).toBe(true);
    const plain = await inspected("square.webm", { heatFrames: 0 });
    expect(decode(a.images.sheet).height).toBeGreaterThan(decode(plain.images.sheet).height);
    expect(JSON.parse(readFileSync(join(out, "report.json"), "utf8")).marks.spans[0].kind).toBe("caption");
  });

  it("decodes H.264 where Chromium has the codec, else explains", async () => {
    try {
      const r = await inspected("square_h264.mp4", { frames: 4, heatFrames: 8 });
      expect(r.report.video!.codec).toBe("h264");
    } catch (err) {
      expect(String(err)).toMatch(/could not decode .*libvpx-vp9/);
    }
  });

  it("rejects video-only options for SVG and bad marks", async () => {
    await expect(inspect(fixture("pipeline.svg"), { browser: browser(), every: 1 })).rejects.toThrow(/only for video/);
    await expect(inspect(fixture("square.webm"), { browser: browser(), marks: { spans: [{ start: 1, end: 0, label: "x" }] } })).rejects.toThrow(
      MarksError,
    );
  });
});
