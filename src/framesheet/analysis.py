"""Render checks: geometry of every element across all sampled frames.

Each check is a function ``(Geometry) -> list[Finding]`` registered in :data:`CHECKS`.
"""

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from framesheet.models import AnimationTiming, ElementTrack, Finding, Rect, as_rect


if TYPE_CHECKING:
    from collections.abc import Callable

    from framesheet.render import Snapshot

TOLERANCE = 1.0
"""Pixels an element may poke out of its container/canvas before it is reported."""
MAX_TRACKS = 30
MAX_REPORTED = 12
SMALL_FRACTION = 0.2
CONTAINERS = {"g", "svg", "a", "switch", "div", "section", "main", "article", "span"}


@dataclass
class Element:
    index: int
    tag: str
    label: str
    svg: bool
    parent: int


@dataclass
class Geometry:
    """Inputs shared by all render checks."""

    elements: dict[int, Element]
    times: list[float]
    client: dict[int, list[Rect | None]]
    """Client rect (CSS px) per element per frame; ``None`` = not rendered/invisible."""
    user: dict[int, list[Rect | None]]
    """SVG user-space rect (outermost ``<svg>``) per element per frame."""
    canvas: Rect
    viewbox: Rect | None
    targets: dict[int, list[str]]
    animations: list[AnimationTiming]
    is_svg_doc: bool
    html_overflow: list[list[Any]] = field(default_factory=list)
    """``[index, dx, dy]`` per frame (list of lists)."""

    @classmethod
    def build(
        cls,
        description: list[dict[str, Any]],
        snapshots: list[Snapshot],
        *,
        canvas: Rect,
        viewbox: Rect | None,
        targets: dict[str, list[str]],
        animations: list[AnimationTiming],
        is_svg_doc: bool,
    ) -> Geometry:
        elements = {
            d["i"]: Element(d["i"], d["tag"], d["label"], d["svg"], d["parent"])
            for d in description
        }
        n = len(snapshots)
        client: dict[int, list[Rect | None]] = {}
        user: dict[int, list[Rect | None]] = {}
        for k, snap in enumerate(snapshots):
            for index, rect, user_rect, visible in snap.geometry:
                if not visible:
                    continue
                client.setdefault(index, [None] * n)[k] = as_rect(rect)
                if user_rect is not None:
                    user.setdefault(index, [None] * n)[k] = as_rect(user_rect)
        return cls(
            elements=elements,
            times=[s.t for s in snapshots],
            client=client,
            user=user,
            canvas=canvas,
            viewbox=viewbox,
            targets={int(k): v for k, v in targets.items()},
            animations=animations,
            is_svg_doc=is_svg_doc,
            html_overflow=[s.overflow for s in snapshots],
        )

    def ancestors(self, index: int) -> list[int]:
        out = []
        parent = self.elements[index].parent if index in self.elements else -1
        while parent != -1 and parent in self.elements:
            out.append(parent)
            parent = self.elements[parent].parent
        return out

    def label(self, index: int) -> str:
        return self.elements[index].label if index in self.elements else f"element {index}"

    def moved(self) -> set[int]:
        out = set()
        for index, rects in self.client.items():
            present = [r for r in rects if r is not None]
            if len(present) != len(rects) and present:
                out.add(index)  # appears / disappears
                continue
            if present and any(_differs(present[0], r) for r in present[1:]):
                out.add(index)
        return out


def _differs(a: Rect, b: Rect, tol: float = 0.5) -> bool:
    return any(abs(x - y) > tol for x, y in zip(a, b))


def _leaves(geo: Geometry, flagged: set[int]) -> set[int]:
    """Drop flagged elements that have a flagged descendant (report the innermost)."""
    covered = {a for i in flagged for a in geo.ancestors(i)}
    return {i for i in flagged if i not in covered}


def _times(geo: Geometry, ks: list[int]) -> list[float]:
    return [geo.times[k] for k in ks]


def _fmt_times(times: list[float]) -> str:
    if len(times) > 4:  # noqa: PLR2004
        return f"t={times[0]:.2f}s..{times[-1]:.2f}s ({len(times)} frames)"
    return "t=" + ", ".join(f"{t:.2f}s" for t in times)


def _finding(code: str, message: str, element: str | None, times: list[float] | None) -> Finding:
    return Finding(
        severity="warning",
        code=code,
        message=message,
        check="render",
        element=element,
        times=times,
    )


def tracks(geo: Geometry) -> list[ElementTrack]:
    """Per-frame boxes of animated elements (declared targets or anything that moved)."""
    moved = geo.moved()
    # A moving group moves all its children: keep the outermost mover. A group whose box
    # only changes because an animated descendant moves is not reported on its own.
    explained = {a for i in geo.targets for a in geo.ancestors(i)} - set(geo.targets)
    indices = {
        i for i in moved - explained if not (set(geo.ancestors(i)) & (moved - explained))
    } | set(geo.targets)
    out = []
    for index in sorted(indices)[:MAX_TRACKS]:
        boxes = geo.user.get(index) or geo.client.get(index)
        if boxes is None:
            continue
        kinds = list(geo.targets.get(index, []))
        if index in moved:
            kinds.append("moved")
        out.append(
            ElementTrack(
                element=geo.label(index),
                animated_by=kinds,
                units="viewBox" if index in geo.user else "px",
                boxes=boxes,
            )
        )
    return out


def check_outside(geo: Geometry) -> list[Finding]:
    """Elements extending past the viewBox (SVG) or viewport (HTML)."""
    cx, cy, cw, ch = geo.canvas
    hits: dict[int, list[int]] = {}
    amounts: dict[int, dict[str, float]] = {}
    for index, rects in geo.client.items():
        for k, rect in enumerate(rects):
            if rect is None:
                continue
            x, y, w, h = rect
            over = {
                "left": cx - x,
                "top": cy - y,
                "right": x + w - (cx + cw),
                "bottom": y + h - (cy + ch),
            }
            worst = {side: v for side, v in over.items() if v > TOLERANCE}
            if worst:
                hits.setdefault(index, []).append(k)
                agg = amounts.setdefault(index, {})
                for side, v in worst.items():
                    agg[side] = max(agg.get(side, 0), v)
    keep = _leaves(geo, set(hits))
    area = "viewBox" if geo.is_svg_doc else "viewport"
    out = []
    ordered = sorted(keep, key=lambda i: -max(amounts[i].values()))
    for index in ordered[:MAX_REPORTED]:
        ks = hits[index]
        sides = ", ".join(f"{v:.0f}px {side}" for side, v in amounts[index].items())
        when = (
            "at every frame" if len(ks) == len(geo.times) else f"at {_fmt_times(_times(geo, ks))}"
        )
        out.append(
            _finding(
                "outside-bounds",
                f"{geo.label(index)} extends outside the {area} {when} (up to {sides}).",
                geo.label(index),
                _times(geo, ks),
            )
        )
    if len(ordered) > MAX_REPORTED:
        out.append(
            _finding(
                "outside-bounds",
                f"... and {len(ordered) - MAX_REPORTED} more element(s) outside the {area}.",
                None,
                None,
            )
        )
    return out


def check_parked(geo: Geometry) -> list[Finding]:
    """Small SVG elements sitting on the user-space origin (0,0), e.g. before ``begin``."""
    if geo.viewbox is None:
        return []
    _, _, vw, vh = geo.viewbox
    hits: dict[int, list[int]] = {}
    for index, rects in geo.user.items():
        element = geo.elements.get(index)
        if element is None or element.tag in CONTAINERS:
            continue
        for k, rect in enumerate(rects):
            if rect is None:
                continue
            x, y, w, h = rect
            small = w < SMALL_FRACTION * vw and h < SMALL_FRACTION * vh
            covers_origin = x <= TOLERANCE and y <= TOLERANCE and x + w >= 0 and y + h >= 0
            if small and covers_origin:
                hits.setdefault(index, []).append(k)
    out = []
    for index in sorted(_leaves(geo, set(hits))):
        ks = hits[index]
        times = _times(geo, ks)
        out.append(
            _finding(
                "parked-at-origin",
                f"{geo.label(index)} sits at the SVG origin (0,0) at {_fmt_times(times)}; "
                "typical cause: <animateMotion> with a positive begin, or a missing x/y/cx/cy.",
                geo.label(index),
                times,
            )
        )
    return out


def check_text_overflow(geo: Geometry) -> list[Finding]:
    """SVG ``<text>`` poking out of the ``<rect>`` painted under it; HTML text overflow."""
    hits: dict[tuple[int, int], list[int]] = {}
    amounts: dict[tuple[int, int], float] = {}
    rects = [i for i, el in geo.elements.items() if el.tag == "rect"]
    for index, el in geo.elements.items():
        if el.tag != "text" or index not in geo.client:
            continue
        for k, text_box in enumerate(geo.client[index]):
            if text_box is None:
                continue
            container = _container(geo, index, text_box, rects, k)
            if container is None:
                continue
            container_box = geo.client[container][k]
            if container_box is None:
                continue
            excess = _excess(text_box, container_box)
            if excess > TOLERANCE:
                key = (index, container)
                hits.setdefault(key, []).append(k)
                amounts[key] = max(amounts.get(key, 0), excess)
    out = [
        _finding(
            "text-overflow",
            f"{geo.label(text)} overflows its container {geo.label(box)} by up to "
            f"{amounts[(text, box)]:.0f}px at {_fmt_times(_times(geo, ks))}.",
            geo.label(text),
            _times(geo, ks),
        )
        for (text, box), ks in sorted(hits.items())
    ]
    html_hits: dict[int, list[int]] = {}
    html_amount: dict[int, tuple[float, float]] = {}
    for k, items in enumerate(geo.html_overflow):
        for index, dx, dy in items:
            html_hits.setdefault(index, []).append(k)
            ox, oy = html_amount.get(index, (0, 0))
            html_amount[index] = (max(ox, dx), max(oy, dy))
    for index, ks in sorted(html_hits.items()):
        dx, dy = html_amount[index]
        out.append(
            _finding(
                "text-overflow",
                f"{geo.label(index)} content is larger than its box ({dx:.0f}px wider, "
                f"{dy:.0f}px taller) at {_fmt_times(_times(geo, ks))}.",
                geo.label(index),
                _times(geo, ks),
            )
        )
    return out


def _area(r: Rect) -> float:
    return r[2] * r[3]


def _overlap(a: Rect, b: Rect) -> float:
    w = min(a[0] + a[2], b[0] + b[2]) - max(a[0], b[0])
    h = min(a[1] + a[3], b[1] + b[3]) - max(a[1], b[1])
    return max(0.0, w) * max(0.0, h)


def _excess(inner: Rect, outer: Rect) -> float:
    return max(
        outer[0] - inner[0],
        outer[1] - inner[1],
        inner[0] + inner[2] - (outer[0] + outer[2]),
        inner[1] + inner[3] - (outer[1] + outer[3]),
    )


def _container(geo: Geometry, text: int, box: Rect, rects: list[int], k: int) -> int | None:
    """Smallest rect painted before ``text`` that covers at least 30% of it."""
    best, best_area = None, float("inf")
    for index in rects:
        if index > text or index not in geo.client:
            continue
        rect = geo.client[index][k]
        if rect is None or _area(box) == 0:
            continue
        if _overlap(box, rect) / _area(box) >= 0.3 and _area(rect) < best_area:  # noqa: PLR2004
            best, best_area = index, _area(rect)
    return best


def check_transform_box(geo: Geometry) -> list[Finding]:
    """CSS transform animations on SVG elements without ``transform-box: fill-box``."""
    out = []
    seen: set[str] = set()
    for anim in geo.animations:
        if anim.transform_box != "view-box" or not anim.target or anim.target in seen:
            continue
        seen.add(anim.target)
        out.append(
            _finding(
                "svg-transform-box",
                f"CSS animation '{anim.name}' on {anim.target} animates transform with "
                "transform-box: view-box (the SVG default), so it rotates/scales around the "
                "SVG origin, not the element. Add transform-box: fill-box; "
                "transform-origin: center.",
                anim.target,
                None,
            )
        )
    return out


CHECKS: list[Callable[[Geometry], list[Finding]]] = [
    check_parked,
    check_outside,
    check_text_overflow,
    check_transform_box,
]
"""Render checks run on every inspection, in order. Append to add a check."""


def run_checks(geo: Geometry) -> list[Finding]:
    findings = [finding for check in CHECKS for finding in check(geo)]
    # An element parked at (0,0) usually pokes out of the top-left corner too: report once.
    parked = {
        (f.element, t) for f in findings if f.code == "parked-at-origin" for t in f.times or []
    }
    return [
        f
        for f in findings
        if not (
            f.code == "outside-bounds"
            and f.times
            and all((f.element, t) in parked for t in f.times)
        )
    ]
