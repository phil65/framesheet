// Fails if the runtime embedded in the build differs from src/framesheet/runtime.js.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const source = readFileSync(join(root, "..", "src", "framesheet", "runtime.js"), "utf8");
const expected = createHash("sha256").update(source, "utf8").digest("hex");

const built = join(root, "dist", "generated", "assets.js");
if (!existsSync(built)) {
  console.error("dist/ is missing: run `npm run build` first");
  process.exit(1);
}
const mod = await import(pathToFileURL(built).href);
const actual = createHash("sha256").update(mod.RUNTIME_JS, "utf8").digest("hex");
if (mod.RUNTIME_JS !== source || mod.RUNTIME_SHA256 !== expected) {
  console.error(
    `runtime.js parity FAILED: dist embeds ${actual.slice(0, 12)}, ` +
      `src/framesheet/runtime.js is ${expected.slice(0, 12)}. Run \`npm run build\`.`,
  );
  process.exit(1);
}
console.log(`runtime.js parity OK (sha256 ${expected.slice(0, 12)})`);
