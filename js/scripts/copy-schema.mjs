// Ship the shared JSON Schemas (../schema/report.schema.json, marks.schema.json) inside the package.
import { copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
for (const name of ["report.schema.json", "marks.schema.json"]) {
  copyFileSync(join(root, "..", "schema", name), join(root, "dist", name));
}
