"""Write the shared report JSON Schema and golden Python reports (used by the npm tests).

    uv run python scripts/sync_schema.py            # schema/report.schema.json + marks
    uv run python scripts/sync_schema.py --golden   # + schema/golden/<fixture>.json
    uv run python scripts/sync_schema.py --golden --out DIR   # goldens into DIR (CI)

Golden reports are generated with fixed options (see ``GOLDEN_OPTIONS``; a fixture with a
``<stem>.marks.json`` next to it is inspected with those marks); paths are reduced to file
names so they do not depend on the machine. ``layout/marks_layout.json`` holds the
overlay/timeline draw ops for fixed inputs (the npm port must produce the same ops).
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import tempfile
from typing import Any

import framesheet
from framesheet import marks as marklib
from framesheet.models import Marks, marks_schema, report_schema


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
    "square.webm",
    "square_gif.gif",
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


def write_schema() -> list[Path]:
    out = []
    for name, schema in (("report", report_schema()), ("marks", marks_schema())):
        path = ROOT / "schema" / f"{name}.schema.json"
        path.write_text(json.dumps(schema, indent=2) + "\n", encoding="utf-8")
        out.append(path)
    return out


def layout_cases() -> dict[str, Any]:
    """Fixed inputs for the marks/timeline layout and the ops Python produces for them."""
    marks = marklib.load_marks(FIXTURES / "square.marks.json")
    extra = Marks.model_validate({
        "frame": {"width": 1920, "height": 1080},
        "points": [
            {"t": 0.4, "x": 1900, "y": 20, "label": "a very long label near the right edge"},
            {"t": 0.45, "x": 10, "y": 1070, "duration": 1.5},
            {"t": 0.5, "x": 960, "y": 540, "label": "third", "kind": "click"},
            {"t": 0.55, "x": 960, "y": 540, "label": "fourth"},
        ],
        "regions": [{"start": 0, "end": 6, "x": 0, "y": 0, "w": 1920, "h": 1080}],
        "spans": [
            {"start": 1, "end": 1.05, "label": "tiny span with a long label"},
            {"start": 1, "end": 4, "label": "overlapping"},
            {"start": 1.2, "end": 3, "label": "third row"},
            {"start": 1.3, "end": 2, "label": "fourth row falls back"},
        ],
    })  # fmt: skip
    times = [0.0, 0.5455, 1.0909, 2.7273, 4.3636, 6.0]
    activity = [(round(k * 0.125, 4), [0, 0.02, 0.3, 0.0004, 1.0][k % 5]) for k in range(49)]
    issues = [
        {"kind": "static", "start": 2.0, "end": 4.375},
        {"kind": "black", "start": 4.5, "end": 4.75},
        {"kind": "cut", "start": 4.5, "end": 4.5},
        {"kind": "blank", "start": 5.0, "end": 5.0},
    ]
    cases: list[dict[str, Any]] = []
    for name, mk in (("square", marks), ("extra", extra)):
        windows = marklib.tile_windows(times, 0.0, 6.0)
        for content in ([0.0, 0.0, 320.0, 180.0], [40.0, 0.0, 240.0, 180.0]):
            for i, t in enumerate(times):
                last = i == len(times) - 1
                cases.append({
                    "type": "tile", "marks": name, "t": t, "window": list(windows[i]),
                    "last": last, "size": [300, 169], "viewport": [320, 180],
                    "content": content,
                    "ops": marklib.tile_ops(
                        mk, t, windows[i], last, size=(300, 169), viewport=(320, 180),
                        content=tuple(content),  # type: ignore[arg-type]
                    ),
                    "labels": marklib.active_labels(mk, t, windows[i], last),
                    "band": marklib.band_text(mk, t),
                })  # fmt: skip
        for width in (560, 1494):
            height, ops = marklib.timeline_ops(
                width, 0.0, 6.0, times, marks=mk, activity=activity, issues=issues
            )
            cases.append({
                "type": "timeline", "marks": name, "width": width, "start": 0.0, "end": 6.0,
                "times": times, "activity": activity, "issues": issues, "height": height,
                "ops": ops,
            })  # fmt: skip
    height, ops = marklib.timeline_ops(1000, 2.5, 17.1333, [2.5, 10.0, 17.1333])
    cases.append({"type": "timeline", "marks": None, "width": 1000, "start": 2.5,
                  "end": 17.1333, "times": [2.5, 10.0, 17.1333], "activity": None,
                  "issues": None, "height": height, "ops": ops})  # fmt: skip
    dumped = {"square": marks.model_dump(mode="json"), "extra": extra.model_dump(mode="json")}
    return {"marks": dumped, "cases": cases}


def write_golden(out: Path) -> list[Path]:
    out.mkdir(parents=True, exist_ok=True)
    written = []
    with tempfile.TemporaryDirectory(prefix="framesheet-golden-") as tmp:
        for name in GOLDEN_FIXTURES:
            marks = FIXTURES / f"{Path(name).stem}.marks.json"
            result = framesheet.inspect(
                FIXTURES / name,
                out=Path(tmp) / Path(name).stem,
                marks=marks if marks.exists() else None,
                **GOLDEN_OPTIONS,
            )
            report = _strip_paths(json.loads(result.model_dump_json()))
            path = out / f"{Path(name).stem}.json"
            path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
            written.append(path)
    layout = out / "layout" / "marks_layout.json"
    layout.parent.mkdir(parents=True, exist_ok=True)
    layout.write_text(json.dumps(layout_cases(), indent=1) + "\n", encoding="utf-8")
    written.append(layout)
    return written


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--golden", action="store_true", help="also write golden reports")
    parser.add_argument("--out", type=Path, default=ROOT / "schema" / "golden")
    args = parser.parse_args()
    for path in write_schema():
        print(path)
    if args.golden:
        for path in write_golden(args.out):
            print(path)


if __name__ == "__main__":
    main()
