// runtime.js has a single source of truth: src/framesheet/runtime.js (Python package data).
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { RUNTIME_JS, RUNTIME_SHA256, VIDEO_JS, VIDEO_SHA256 } from "../src/generated/assets.js";
import { JS_ROOT, REPO_ROOT } from "./helpers.js";

const SOURCE = readFileSync(join(REPO_ROOT, "src", "framesheet", "runtime.js"), "utf8");
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

describe("runtime.js parity", () => {
  it("embeds the Python package's runtime.js byte for byte", () => {
    expect(RUNTIME_JS).toBe(SOURCE);
    expect(RUNTIME_SHA256).toBe(sha(SOURCE));
  });

  it("embeds the Python package's video.js byte for byte", () => {
    const video = readFileSync(join(REPO_ROOT, "src", "framesheet", "video.js"), "utf8");
    expect(VIDEO_JS).toBe(video);
    expect(VIDEO_SHA256).toBe(sha(video));
  });

  it("ships the same runtime in dist/ (if built)", async (ctx) => {
    const built = join(JS_ROOT, "dist", "generated", "assets.js");
    if (!existsSync(built)) ctx.skip();
    const mod = (await import(pathToFileURL(built).href)) as { RUNTIME_JS: string };
    expect(sha(mod.RUNTIME_JS)).toBe(sha(SOURCE));
  });
});
