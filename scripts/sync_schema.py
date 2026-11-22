"""Write the shared report JSON Schema and golden Python reports (used by the npm tests).

    uv run python scripts/sync_schema.py            # schema/report.schema.json
    uv run python scripts/sync_schema.py --golden   # + schema/golden/<fixture>.json
    uv run python scripts/sync_schema.py --golden --out DIR   # goldens into DIR (CI)

Golden reports are generated with fixed options (see ``GOLDEN_OPTIONS``); paths are
reduced to file names so they do not depend on the machine.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import tempfile
from typing import Any

import framesheet
from framesheet.models import report_schema


ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "tests" / "fixtures"
GOLDEN_OPTIONS: dict[str, Any] = {"frames": 12, "heat_frames": 48}
GOLDEN_FIXTURES = [
    "finite.svg",
    "fly_out.svg",
    "html_overflow.html",
    "non_seamless.svg",
    "parked_dot.svg",
    "pipeline.svg",
    "raf_canvas.html",
    "rotate_no_box.svg",
    "text_overflow.svg",
    "waapi.html",
]


def _strip_paths(report: dict[str, Any]) -> dict[str, Any]:
    report["source"] = Path(report["source"]).name
    report["images"] = {key: Path(value).name for key, value in report["images"].items()}
    for frame in report["frames"]:
        if frame.get("path"):
            frame["path"] = Path(frame["path"]).name
    return report


def write_schema() -> Path:
    path = ROOT / "schema" / "report.schema.json"
    path.write_text(json.dumps(report_schema(), indent=2) + "\n", encoding="utf-8")
    return path


def write_golden(out: Path) -> list[Path]:
    out.mkdir(parents=True, exist_ok=True)
    written = []
    with tempfile.TemporaryDirectory(prefix="framesheet-golden-") as tmp:
        for name in GOLDEN_FIXTURES:
            result = framesheet.inspect(
                FIXTURES / name, out=Path(tmp) / Path(name).stem, **GOLDEN_OPTIONS
            )
            report = _strip_paths(json.loads(result.model_dump_json()))
            path = out / f"{Path(name).stem}.json"
            path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
            written.append(path)
    return written


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--golden", action="store_true", help="also write golden reports")
    parser.add_argument("--out", type=Path, default=ROOT / "schema" / "golden")
    args = parser.parse_args()
    print(write_schema())
    if args.golden:
        for path in write_golden(args.out):
            print(path)


if __name__ == "__main__":
    main()
