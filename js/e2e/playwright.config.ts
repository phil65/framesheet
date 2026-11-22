import { defineConfig, devices } from "@playwright/test";
import { LAUNCH_ARGS } from "framesheet";

// Demo of framesheet/test in a Playwright suite. LAUNCH_ARGS keep frames byte-stable
// (compositor animations on the main thread, sRGB, no LCD text).
export default defineConfig({
  testDir: ".",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    ...devices["Desktop Chrome"],
    viewport: { width: 640, height: 400 },
    launchOptions: { args: LAUNCH_ARGS },
  },
  projects: [{ name: "chromium" }],
});
