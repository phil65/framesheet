// Smoke test of the built package (dist/) under any runtime: node scripts/smoke.mjs,
// bun scripts/smoke.mjs. Imports through the package's own exports map.
import { inspect, RUNTIME_SHA256 } from "framesheet";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "tests", "fixtures");
const result = await inspect(join(fixtures, "parked_dot.svg"), { frames: 4, heatFrames: 8 });
const codes = result.codes();
const runtime = typeof process.versions.bun === "string" ? `bun ${process.versions.bun}` : `node ${process.version}`;
if (!codes.has("parked-at-origin") || result.images.sheet.length < 1000) {
  console.error(`smoke FAILED (${runtime}):\n${result.summary()}`);
  process.exit(1);
}
console.log(`smoke OK (${runtime}, runtime ${RUNTIME_SHA256.slice(0, 12)}): ${[...codes].join(", ")}`);
