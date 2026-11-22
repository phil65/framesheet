// Ship the shared report JSON Schema (../schema/report.schema.json) inside the package.
import { copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
copyFileSync(join(root, "..", "schema", "report.schema.json"), join(root, "dist", "report.schema.json"));
