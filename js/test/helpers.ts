import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium } from "playwright-core";
import { afterAll, beforeAll } from "vitest";
import { LAUNCH_ARGS } from "../src/index.js";

export const JS_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_ROOT = join(JS_ROOT, "..");
/** The Python test fixtures (reused, not copied). */
export const FIXTURES = join(REPO_ROOT, "tests", "fixtures");
export const SCHEMA_PATH = join(REPO_ROOT, "schema", "report.schema.json");
export const GOLDEN_DIR = process.env.FRAMESHEET_GOLDEN_DIR ?? join(REPO_ROOT, "schema", "golden");

export const fixture = (name: string) => join(FIXTURES, name);

/** One Chromium per test file (launched like framesheet does). */
export function useBrowser(): () => Browser {
  let browser: Browser | null = null;
  beforeAll(async () => {
    browser = await chromium.launch({ args: LAUNCH_ARGS });
  });
  afterAll(async () => {
    await browser?.close();
  });
  return () => {
    if (!browser) throw new Error("browser not launched yet");
    return browser;
  };
}
