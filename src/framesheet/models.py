"""Result models for framesheet inspections."""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal

from pydantic import BaseModel, Field


if TYPE_CHECKING:
    from collections.abc import Sequence


Severity = Literal["error", "warning", "info"]
SourceKind = Literal["svg", "html"]
ColorScheme = Literal["light", "dark"]
Rect = tuple[float, float, float, float]
"""An axis-aligned box as ``(x, y, width, height)``."""


FINDING_CODES: dict[str, tuple[Severity, Literal["static", "render"], str]] = {
    # Static checks (checks.py): source text.
    "malformed-xml": ("error", "static", "The SVG is not well-formed XML."),
    "not-svg": ("error", "static", "The root element is not <svg>."),
    "missing-xmlns": ("error", "static", "The root <svg> lacks the SVG namespace."),
    "missing-viewbox": ("error", "static", "The root <svg> has no viewBox."),
    "missing-title": ("warning", "static", "No aria-label or <title>."),
    "script": ("error", "static", "Contains <script>."),
    "foreign-object": ("warning", "static", "Contains <foreignObject>."),
    "event-handler": ("error", "static", "Inline on* event handler attribute."),
    "external-url": ("warning", "static", "External http(s) URL in an attribute."),
    "positive-begin": ("warning", "static", "<animateMotion> with a positive begin."),
    "duplicate-id": ("error", "static", "The same id is used more than once."),
    "broken-ref": ("error", "static", "#id / url(#id) reference without a matching id."),
    "css-external": ("warning", "static", "CSS references an external URL or font."),
    "no-reduced-motion": ("warning", "static", "CSS animations without prefers-reduced-motion."),
    "transform-origin-without-box": (
        "warning",
        "static",
        "CSS transform-origin without transform-box in SVG.",
    ),
    "transform-without-box": (
        "warning",
        "static",
        "@keyframes animate transforms in SVG without transform-box.",
    ),
    "large-file": ("warning", "static", "SVG larger than 100 KB."),
    # Render checks (analysis.py, core.py): pixels and geometry over time.
    "parked-at-origin": ("warning", "render", "Small SVG element sits at the origin (0,0)."),
    "outside-bounds": ("warning", "render", "Element extends outside the viewBox/viewport."),
    "text-overflow": ("warning", "render", "Text larger than its container."),
    "svg-transform-box": (
        "warning",
        "render",
        "CSS transform animation pivots around the SVG origin.",
    ),
    "non-seamless-loop": ("warning", "render", "The loop jumps at the cycle end."),
    "js-driven-motion": ("warning", "render", "Pixels change without declarative animations."),
    "no-visible-motion": ("info", "render", "Animations declared but no pixel changed."),
    "no-motion": ("info", "render", "No animation and no pixel change."),
    "console-error": ("warning", "render", "console.error or uncaught page error."),
}
"""Every finding code (API: stable, kebab-case) -> (usual severity, check, meaning).

Both implementations (Python and npm) may only emit these; the shared JSON Schema
(``schema/report.schema.json``) pins them as an enum. Add new codes here first.
"""


def as_rect(values: Sequence[float]) -> Rect:
    """Coerce a 4-item sequence (e.g. a JSON list from the page) to a :data:`Rect`."""
    x, y, w, h = values
    return float(x), float(y), float(w), float(h)


class Finding(BaseModel):
    """A single problem (or noteworthy fact) found by a static or render check."""

    severity: Severity
    code: str
    """Stable, kebab-case identifier, e.g. ``parked-at-origin``."""
    message: str
    check: Literal["static", "render"]
    element: str | None = None
    """Human-readable element label such as ``circle#dot`` or ``text[2] "Hello"``."""
    times: list[float] | None = None
    """Sample times (seconds) at which the problem was observed."""


class AnimationTiming(BaseModel):
    """Timing of one declarative animation, as reported by the browser."""

    kind: Literal["smil", "css-animation", "css-transition", "web-animation"]
    target: str | None = None
    name: str | None = None
    start: float
    """Begin / delay in seconds (may be negative)."""
    duration: float
    """Duration of one iteration in seconds."""
    iterations: float | None
    """Iteration count; ``None`` means infinite."""
    direction: str = "normal"
    period: float
    """Seconds until the animation looks the same again (2x duration for alternate)."""
    end: float | None
    """End of the active interval in seconds; ``None`` if infinite."""
    transform_box: str | None = None
    """Computed ``transform-box`` of an SVG target whose transform is animated by CSS."""


class DurationInfo(BaseModel):
    """The sampled time span and how it was chosen."""

    seconds: float
    method: Literal["override", "detected", "fallback"]
    looping: bool
    """True if at least one animation repeats forever (or motion is JS-driven)."""
    detail: str
    animations: list[AnimationTiming] = Field(default_factory=list)


class FrameMetrics(BaseModel):
    """Per-frame numbers."""

    index: int
    t: float
    changed_ratio: float
    """Share of pixels that differ from the previous frame (0 for the first frame)."""
    changed_box: Rect | None = None
    """Bounding box (CSS px) of the pixels that changed vs. the previous frame."""
    path: Path | None = None
    """Path of the individual frame PNG, if frames were kept."""


class ElementTrack(BaseModel):
    """Geometry of one animated element over all frames."""

    element: str
    animated_by: list[str]
    """``smil``, ``css-animation``, ``web-animation`` and/or ``moved`` (geometry changed)."""
    units: Literal["viewBox", "px"]
    boxes: list[Rect | None]
    """One box per frame (``None`` if not rendered at that frame)."""


class LoopInfo(BaseModel):
    """How cleanly the last frame of a cycle joins the first."""

    checked: bool
    seamless: bool | None = None
    seam_ratio: float | None = None
    """Changed-pixel share between ``t=end-epsilon`` and ``t=0``."""
    step_ratio: float | None = None
    """Changed-pixel share between ``t=0`` and ``t=epsilon`` (normal motion per step)."""
    seam_box: Rect | None = None
    detail: str


class Images(BaseModel):
    full: Path
    sheet: Path
    heatmap: Path
    report: Path


class InspectionResult(BaseModel):
    """Everything framesheet found out about one input."""

    source: str
    kind: SourceKind
    viewport: tuple[int, int]
    device_scale_factor: float
    canvas: Rect
    """Drawing area in CSS px (the viewBox for SVG documents, the viewport for HTML)."""
    duration: DurationInfo
    times: list[float]
    """Sample times of the contact-sheet tiles in seconds."""
    full_at: float
    images: Images
    findings: list[Finding]
    frames: list[FrameMetrics]
    elements: list[ElementTrack]
    loop: LoopInfo
    console_errors: list[str] = Field(default_factory=list)

    @property
    def errors(self) -> list[Finding]:
        return [f for f in self.findings if f.severity == "error"]

    @property
    def warnings(self) -> list[Finding]:
        return [f for f in self.findings if f.severity == "warning"]

    def codes(self) -> set[str]:
        """All finding codes, handy for assertions."""
        return {f.code for f in self.findings}

    def summary(self) -> str:
        """Concise multi-line text for humans and agents (what the CLI prints)."""
        w, h = self.viewport
        d = self.duration
        lines = [
            f"framesheet: {self.source} ({self.kind}, {w}x{h} @{self.device_scale_factor:g}x)",
            f"duration: {d.seconds:g}s {d.method}: {d.detail}"
            + (" [looping]" if d.looping else ""),
        ]
        busiest = max(self.frames, key=lambda f: f.changed_ratio)
        motion = (
            f"max change {busiest.changed_ratio:.1%} at t={busiest.t:.2f}s"
            if busiest.changed_ratio
            else "no pixel changes"
        )
        lines.append(
            f"frames: {len(self.times)} at t={self.times[0]:.2f}..{self.times[-1]:.2f}s; {motion}"
        )
        if self.loop.checked:
            verdict = "seamless" if self.loop.seamless else "NOT seamless"
            lines.append(f"loop: {verdict} ({self.loop.detail})")
        else:
            lines.append(f"loop: not checked ({self.loop.detail})")
        moving = [e.element for e in self.elements][:8]
        if moving:
            more = f" (+{len(self.elements) - 8} more)" if len(self.elements) > 8 else ""  # noqa: PLR2004
            lines.append(f"animated elements: {', '.join(moving)}{more}")
        counts = {
            s: sum(f.severity == s for f in self.findings) for s in ("error", "warning", "info")
        }
        lines.append(
            f"findings: {counts['error']} error(s), {counts['warning']} warning(s), "
            f"{counts['info']} info"
        )
        tags = {"error": "ERROR", "warning": "WARN ", "info": "INFO "}
        lines.extend(
            f"  {tags[f.severity]} [{f.check}] {f.code}: {f.message}" for f in self.findings
        )
        lines += [
            "images:",
            f"  full     {self.images.full}  (t={self.full_at:g}s: layout, text, margins)",
            f"  sheet    {self.images.sheet}  (motion over one cycle)",
            f"  heatmap  {self.images.heatmap}  (what moves at all)",
            f"  report   {self.images.report}",
        ]
        return "\n".join(lines)


def report_schema() -> dict[str, Any]:
    """JSON Schema of ``report.json``, shared with the npm package (``schema/``).

    Generated from :class:`InspectionResult` in serialization mode; every object is closed
    (``additionalProperties: false``) and every field required, because both
    implementations always write all fields (``null`` for unset ones).
    """

    def close(node: Any) -> None:
        if isinstance(node, dict):
            if node.get("type") == "object" and "properties" in node:
                node["additionalProperties"] = False
                node["required"] = list(node["properties"])
            for value in node.values():
                close(value)
        elif isinstance(node, list):
            for value in node:
                close(value)

    schema = InspectionResult.model_json_schema(mode="serialization")
    close(schema)
    code = schema["$defs"]["Finding"]["properties"]["code"]
    code["enum"] = list(FINDING_CODES)
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": "https://github.com/phil65/framesheet/schema/report.schema.json",
        **schema,
        "x-finding-codes": {
            name: {"severity": severity, "check": check, "description": text}
            for name, (severity, check, text) in FINDING_CODES.items()
        },
    }
