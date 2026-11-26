"""Marks (``--marks marks.json``): loading, activity per tile, overlay/timeline layout.

Which marks are active on a tile, and the pure layout of tile overlays and the timeline
strip under a video sheet.

Layout functions return draw ops (see :func:`framesheet.compose.draw_ops`) with integer
coordinates and no font measuring (text widths are estimated from the character count),
so the npm port (``js/src/marks.ts``) produces exactly the same ops.
"""

import json
import math
from pathlib import Path
from typing import TYPE_CHECKING, Any

from framesheet.models import MarkPoint, Marks


if TYPE_CHECKING:
    from collections.abc import Sequence

    from framesheet.compose import DrawOp
    from framesheet.models import Rect

CHAR_W = 0.58
"""Estimated advance of one character in em (Aileron averages ~0.5)."""
ELLIPSIS = "…"
INK = [17, 24, 39]
MUTED = [75, 85, 99]
WHITE = [255, 255, 255]
POINT = [236, 72, 153]
POINT_TEXT = [190, 24, 93]
REGION = [34, 211, 238]
REGION_BAR = [8, 145, 178]
SPAN_BOX = [167, 139, 250]
SPAN_BAR = [124, 58, 237]
STATIC = [245, 158, 11]
CUT = [220, 38, 38]
LANE_BG = [241, 245, 249]
GUIDE = [203, 213, 225]
TICK = [190, 18, 60]
BAR = [71, 85, 105]
BORDER = [100, 116, 139]
PAD = 12
LABEL_COL = 76
ROW_H = 22
MAX_ROWS = 3
NICE_STEPS = [0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600]


def load_marks(value: str | Path | dict[str, Any] | Marks) -> Marks:
    """Validate marks from a path, a JSON string, a dict or a :class:`Marks`."""
    if isinstance(value, Marks):
        return value
    if isinstance(value, dict):
        return Marks.model_validate(value)
    text = str(value)
    if not text.lstrip().startswith("{"):
        text = Path(value).expanduser().read_text(encoding="utf-8")
    return Marks.model_validate(json.loads(text))


def est_width(text: str, size: int) -> int:
    return math.ceil(len(text) * size * CHAR_W)


def fit(text: str, size: int, max_w: float) -> str:
    """Truncate ``text`` (with an ellipsis) to an estimated width of ``max_w`` px."""
    n = math.floor(max_w / (size * CHAR_W))
    if len(text) <= n:
        return text
    if n < 2:  # noqa: PLR2004
        return ""
    return text[: n - 1] + ELLIPSIS


def tile_windows(times: Sequence[float], start: float, end: float) -> list[tuple[float, float]]:
    """Time window each tile stands for: halfway to its neighbours (range ends outside)."""
    out = []
    for i, t in enumerate(times):
        lo = start if i == 0 else (times[i - 1] + t) / 2
        hi = end if i == len(times) - 1 else (t + times[i + 1]) / 2
        out.append((lo, hi))
    return out


def point_active(p: MarkPoint, window: tuple[float, float], last: bool) -> bool:
    lo, hi = window
    a, b = p.t, p.t + p.duration
    return (a <= hi if last else a < hi) and b >= lo


def _point_label(p: MarkPoint) -> str:
    return f"{p.label or p.kind or 'point'} @{p.t:.2f}s"


def active_labels(marks: Marks, t: float, window: tuple[float, float], last: bool) -> list[str]:
    """Labels of all marks active on a tile (spans, regions, points)."""
    out = [s.label for s in marks.spans if s.start <= t <= s.end]
    out += [r.label or r.kind or "region" for r in marks.regions if r.start <= t <= r.end]
    out += [_point_label(p) for p in marks.points if point_active(p, window, last)]
    return out


def band_text(marks: Marks, t: float) -> str:
    """Second label line of a tile: active spans and box-less regions."""
    parts = [s.label for s in marks.spans if s.start <= t <= s.end]
    parts += [
        r.label or r.kind or "region"
        for r in marks.regions
        if r.box is None and r.start <= t <= r.end
    ]
    return "  |  ".join(parts)


def has_band(marks: Marks) -> bool:
    return bool(marks.spans) or any(r.box is None for r in marks.regions)


def _clip(box: Sequence[int], w: int, h: int) -> list[int] | None:
    x0, y0, x1, y1 = max(0, box[0]), max(0, box[1]), min(w - 1, box[2]), min(h - 1, box[3])
    return [x0, y0, x1, y1] if x0 <= x1 and y0 <= y1 else None


def _rect(ops: list[DrawOp], box: Sequence[int], fill: list[int], w: int, h: int) -> None:
    if c := _clip(box, w, h):
        ops.append({"op": "rect", "box": c, "fill": fill})


def _outline(
    ops: list[DrawOp], box: Sequence[int], color: list[int], width: int, w: int, h: int
) -> None:
    if c := _clip(box, w, h):
        ops.append({"op": "outline", "box": c, "color": color, "width": width})


def _tag(
    ops: list[DrawOp],
    text: str,
    x: int,
    y: int,
    fill: list[int],
    color: list[int],
    w: int,
    h: int,
) -> None:
    """A filled label tag with its top-left at ``x, y`` (kept inside the tile)."""
    if not text:
        return
    tw = est_width(text, 13) + 8
    x = max(0, min(x, w - tw))
    y = max(0, min(y, h - 18))
    _rect(ops, [x, y, x + tw - 1, y + 17], fill, w, h)
    ops.append({"op": "text", "x": x + 4, "y": y + 2, "text": text, "color": color, "size": 13})


def tile_ops(
    marks: Marks,
    t: float,
    window: tuple[float, float],
    last: bool,
    *,
    size: tuple[int, int],
    viewport: tuple[int, int],
    content: Rect,
) -> list[DrawOp]:
    """Overlay ops for one tile image of ``size`` px (top-left = 0, 0).

    ``content`` is where the video frame sits in the ``viewport`` (CSS px); mark
    coordinates are relative to it.
    """
    w, h = size
    sx, sy = w / viewport[0], h / viewport[1]
    cx, cy, cw, ch = content

    def at(nx: float, ny: float) -> tuple[int, int]:
        fx, fy = marks.norm(nx, ny)
        return math.floor((cx + fx * cw) * sx), math.floor((cy + fy * ch) * sy)

    ops: list[DrawOp] = []
    boxed: list[tuple[Any, list[int], str]] = [
        (r, REGION, r.label or r.kind or "region")
        for r in marks.regions
        if r.box is not None and r.start <= t <= r.end
    ]
    boxed += [
        (s, SPAN_BOX, s.label) for s in marks.spans if s.box is not None and s.start <= t <= s.end
    ]
    for item, color, label in boxed:
        bx, by, bw, bh = item.box
        x0, y0 = at(bx, by)
        x1, y1 = at(bx + bw, by + bh)
        x1, y1 = max(x0, x1 - 1), max(y0, y1 - 1)
        _outline(ops, [x0 - 1, y0 - 1, x1 + 1, y1 + 1], INK, 1, w, h)
        _outline(ops, [x0, y0, x1, y1], color, 2, w, h)
        text = fit(label, 13, max(60, x1 - x0))
        _tag(ops, text, x0, y0 - 18 if y0 >= 18 else y0 + 2, color, INK, w, h)  # noqa: PLR2004
    for p in marks.points:
        if not point_active(p, window, last):
            continue
        x, y = at(p.x, p.y)
        _outline(ops, [x - 7, y - 7, x + 7, y + 7], INK, 1, w, h)
        _outline(ops, [x - 6, y - 6, x + 6, y + 6], POINT, 2, w, h)
        for box in (
            [x - 12, y - 1, x - 8, y + 1],
            [x + 8, y - 1, x + 12, y + 1],
            [x - 1, y - 12, x + 1, y - 8],
            [x - 1, y + 8, x + 1, y + 12],
            [x - 1, y - 1, x + 1, y + 1],
        ):
            _rect(ops, box, POINT, w, h)
        text = fit(_point_label(p), 13, 220)
        tw = est_width(text, 13) + 8
        tx = x + 14 if x + 14 + tw <= w else x - 14 - tw
        _tag(ops, text, tx, y - 9, POINT, WHITE, w, h)
    return ops


def _nice_step(span: float, width: int) -> float:
    for step in NICE_STEPS:
        if span / step <= width / 90:
            return step
    return NICE_STEPS[-1]


def _rows(items: list[tuple[int, int]]) -> list[int]:
    """Greedy row per item extent ``(x0, x1)`` (items sorted by x0), at most MAX_ROWS."""
    ends: list[int] = []
    rows = []
    for x0, x1 in items:
        row = next((r for r, end in enumerate(ends) if end + 6 <= x0), None)
        if row is None:
            if len(ends) < MAX_ROWS:
                row = len(ends)
                ends.append(x1)
            else:
                row = min(range(len(ends)), key=lambda r: ends[r])
        ends[row] = max(ends[row], x1)
        rows.append(row)
    return rows


def timeline_ops(
    width: int,
    start: float,
    end: float,
    times: Sequence[float],
    *,
    marks: Marks | None = None,
    activity: Sequence[tuple[float, float]] | None = None,
    issues: Sequence[dict[str, Any]] | None = None,
) -> tuple[int, list[DrawOp]]:
    """The timeline strip: motion, issues, spans, regions, points, tile axis.

    Returns ``(height, ops)`` with ops relative to the strip's top-left.

    Args:
        width: Sheet width.
        start: Range start (s).
        end: Range end (s).
        times: Tile times.
        marks: Marks to draw (spans, regions and points lanes).
        activity: ``(t, changed_ratio)`` of every dense sample (motion lane).
        issues: ``{"kind": static|black|blank|cut, "start", "end"}`` (issues lane).
    """
    left, right = PAD + LABEL_COL, width - PAD - 1
    span = max(end - start, 1e-9)

    def X(t: float) -> int:  # noqa: N802
        f = min(1.0, max(0.0, (t - start) / span))
        return left + math.floor(f * (right - left))

    back: list[DrawOp] = []
    front: list[DrawOp] = []
    title = f"timeline {start:.2f}-{end:.2f}s: tiles #1-#{len(times)}" + (
        "; motion = changed pixels per sample" if activity is not None else ""
    )
    front.append({"op": "text", "x": PAD, "y": 8, "text": title, "color": INK, "size": 16})
    y = 34
    lanes_top = y

    def lane(name: str, height: int) -> int:
        nonlocal y
        top = y
        back.append({"op": "rect", "box": [left, top, right, top + height - 1], "fill": LANE_BG})
        front.append(
            {"op": "text", "x": PAD, "y": top + (height - 13) // 2 - 1, "text": name,
             "color": MUTED, "size": 13}
        )  # fmt: skip
        y += height + 4
        return top

    if activity is not None:
        h = 34
        top = lane("motion", h)
        for k in range(1, len(activity)):
            ratio = activity[k][1]
            if ratio <= 0:
                continue
            bh = max(1, math.floor(h * min(1.0, math.sqrt(ratio / 0.25))))
            x0, x1 = X(activity[k - 1][0]), X(activity[k][0])
            front.append({"op": "rect", "box": [x0, top + h - bh, max(x0, x1 - 1), top + h - 1],
                          "fill": BAR})  # fmt: skip
    if issues is not None:
        h = 20
        top = lane("issues", h)
        if not issues:
            front.append({"op": "text", "x": left + 4, "y": top + 3, "text": "none",
                          "color": MUTED, "size": 12})  # fmt: skip
        for issue in issues:
            x0, x1 = X(issue["start"]), X(issue["end"])
            kind = issue["kind"]
            if kind == "static":
                front.append({"op": "rect", "box": [x0, top + 3, max(x0 + 1, x1), top + 16],
                              "fill": STATIC})  # fmt: skip
                text = fit(f"static {issue['end'] - issue['start']:.1f}s", 12, x1 - x0 - 4)
                if text:
                    front.append({"op": "text", "x": x0 + 3, "y": top + 3, "text": text,
                                  "color": INK, "size": 12})  # fmt: skip
            elif kind in {"black", "blank"}:
                box = [x0, top + 2, max(x1, x0 + 3), top + h - 3]
                front.append({"op": "rect", "box": box,
                              "fill": [0, 0, 0] if kind == "black" else WHITE})  # fmt: skip
                if kind == "blank":
                    front.append({"op": "outline", "box": box, "color": BORDER, "width": 1})
            elif kind == "cut":
                front.append({"op": "rect", "box": [x0 - 1, top, x0, top + h - 1], "fill": CUT})
    if marks is not None:
        bars: list[tuple[str, list[tuple[float, float, str]], list[int]]] = [
            ("spans", [(s.start, s.end, s.label) for s in marks.spans], SPAN_BAR),
            (
                "regions",
                [(r.start, r.end, r.label or r.kind or "region") for r in marks.regions],
                REGION_BAR,
            ),
        ]
        for name, items, color in bars:
            if not items:
                continue
            items = sorted(items, key=lambda it: (it[0], it[1]))
            geo = []
            for s, e, label in items:
                x0, x1 = X(s), max(X(e), X(s) + 2)
                inside = fit(label, 13, x1 - x0 - 8)
                outside = len(inside) < min(4, len(label))
                text = fit(label, 13, 200) if outside else inside
                extent = x1 + 4 + est_width(text, 13) if outside else x1
                geo.append((x0, x1, text, outside, extent))
            rows = _rows([(g[0], g[4]) for g in geo])
            n = max(rows) + 1
            top = lane(name, n * ROW_H)
            for (x0, x1, text, outside, _), row in zip(geo, rows):
                ry = top + row * ROW_H
                front.append({"op": "rect", "box": [x0, ry + 2, x1, ry + 19], "fill": color})
                if text:
                    front.append({
                        "op": "text", "x": x1 + 4 if outside else x0 + 4, "y": ry + 4,
                        "text": text, "color": color if outside else WHITE, "size": 13,
                    })  # fmt: skip
        if marks.points:
            pts = sorted(marks.points, key=lambda p: p.t)
            geo2 = []
            for p in pts:
                x = X(p.t)
                text = fit(p.label or p.kind or "", 13, 200)
                geo2.append((x, text, X(p.t + p.duration)))
            rows = _rows([(g[0] - 2, max(g[2], g[0] + 5 + est_width(g[1], 13))) for g in geo2])
            top = lane("points", (max(rows) + 1) * ROW_H)
            for (x, text, x_end), row in zip(geo2, rows):
                ry = top + row * ROW_H
                if x_end > x:
                    front.append({"op": "rect", "box": [x, ry + 9, x_end, ry + 12], "fill": POINT})
                front.append({"op": "rect", "box": [x - 1, ry + 2, x + 1, ry + 19], "fill": POINT})
                if text:
                    front.append({"op": "text", "x": x + 5, "y": ry + 4, "text": text,
                                  "color": POINT_TEXT, "size": 13})  # fmt: skip
    lanes_bottom = y - 4
    # Tile axis: ticks + tile numbers above the baseline, seconds below.
    axis = y + 2
    front.append({"op": "text", "x": PAD, "y": axis + 4, "text": "tiles", "color": MUTED,
                  "size": 13})  # fmt: skip
    front.append({"op": "rect", "box": [left, axis + 14, right, axis + 14], "fill": BORDER})
    last_label = -(10**9)
    for i, t in enumerate(times):
        x = X(t)
        if lanes_bottom > lanes_top:
            back.append({"op": "rect", "box": [x, lanes_top, x, lanes_bottom], "fill": GUIDE})
        front.append({"op": "rect", "box": [x - 1, axis + 4, x, axis + 14], "fill": TICK})
        text = f"#{i + 1}"
        tw = est_width(text, 12)
        tx = x + 2 if x + 2 + tw <= right else x - 3 - tw  # the end tile: left of its tick
        if tx >= last_label + 4:
            front.append({"op": "text", "x": tx, "y": axis, "text": text, "color": TICK,
                          "size": 12})  # fmt: skip
            last_label = tx + tw
    step = _nice_step(span, right - left)
    k = math.ceil(start / step - 1e-9)
    last_label = -(10**9)
    while k * step <= end + 1e-9:
        v = k * step
        x = X(v)
        front.append({"op": "rect", "box": [x, axis + 15, x, axis + 19], "fill": BORDER})
        text = f"{v:g}s"
        tw = est_width(text, 12)
        if x + 2 >= last_label + 6 and x + 2 + tw <= width - PAD:
            front.append({"op": "text", "x": x + 2, "y": axis + 19, "text": text,
                          "color": MUTED, "size": 12})  # fmt: skip
            last_label = x + 2 + tw
        k += 1
    height = axis + 36 + PAD
    return height, back + front
