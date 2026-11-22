"""Result models for framesheet inspections."""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


if TYPE_CHECKING:
    from collections.abc import Sequence


Severity = Literal["error", "warning", "info"]
SourceKind = Literal["svg", "html", "video"]
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
    # Video checks (video.py): dense samples of a video/animated image.
    "video-static-stretch": (
        "warning",
        "render",
        "No visible change for longer than the static threshold (dead time).",
    ),
    "video-black-frames": ("warning", "render", "Sampled frames that are (almost) all black."),
    "video-blank-frames": ("warning", "render", "Sampled frames of one flat colour (not black)."),
    "video-abrupt-cut": ("info", "render", "One large change between quiet neighbours."),
    "video-mark-overlap": (
        "warning",
        "render",
        "A span box (e.g. a caption) covers an active target region.",
    ),
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
    method: Literal["override", "detected", "fallback", "media"]
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


class _Box(BaseModel):
    """Optional box ``x, y, w, h`` (all four or none), normalized 0-1 unless ``frame``."""

    x: float | None = None
    y: float | None = None
    w: float | None = Field(default=None, gt=0)
    h: float | None = Field(default=None, gt=0)

    @model_validator(mode="after")
    def _all_or_none(self) -> Any:
        given = [v is not None for v in (self.x, self.y, self.w, self.h)]
        if any(given) and not all(given):
            msg = "x, y, w, h must be given together (or not at all)"
            raise ValueError(msg)
        return self

    @property
    def box(self) -> Rect | None:
        if self.x is None or self.y is None or self.w is None or self.h is None:
            return None
        return (self.x, self.y, self.w, self.h)


class MarkPoint(BaseModel):
    """An instant at a position, e.g. a click: drawn on the tile nearest to ``t``."""

    model_config = ConfigDict(extra="forbid", strict=True)
    t: float = Field(ge=0)
    x: float
    y: float
    label: str | None = None
    kind: str | None = None
    """Free-form, e.g. ``click``."""
    duration: float = Field(default=0.0, ge=0)
    """Seconds the point stays relevant (drawn on every tile it overlaps)."""


class MarkRegion(_Box):
    """A time range, optionally with a box: a target element, a zoom, a highlight."""

    model_config = ConfigDict(extra="forbid", strict=True)
    start: float = Field(ge=0)
    end: float = Field(ge=0)
    label: str | None = None
    kind: str | None = None
    """Free-form, e.g. ``zoom``. ``target`` boxes are checked against span boxes."""

    @model_validator(mode="after")
    def _ordered(self) -> Any:
        if self.end < self.start:
            msg = "end must be >= start"
            raise ValueError(msg)
        return self


class MarkSpan(_Box):
    """A labelled time range, e.g. a caption; the optional box is its screen area."""

    model_config = ConfigDict(extra="forbid", strict=True)
    start: float = Field(ge=0)
    end: float = Field(ge=0)
    label: str
    kind: str | None = None
    """Free-form, e.g. ``caption``."""

    @model_validator(mode="after")
    def _ordered(self) -> Any:
        if self.end < self.start:
            msg = "end must be >= start"
            raise ValueError(msg)
        return self


class MarkFrame(BaseModel):
    """Pixel size the coordinates refer to (omit for normalized 0-1 coordinates)."""

    model_config = ConfigDict(extra="forbid", strict=True)
    width: float = Field(gt=0)
    height: float = Field(gt=0)


class Marks(BaseModel):
    """Annotations drawn onto video tiles and the timeline (``--marks marks.json``).

    Times are seconds of the media; coordinates are fractions (0-1) of the video frame,
    or pixels of ``frame`` if given.
    """

    model_config = ConfigDict(extra="forbid", strict=True)
    frame: MarkFrame | None = None
    points: list[MarkPoint] = Field(default_factory=list)
    regions: list[MarkRegion] = Field(default_factory=list)
    spans: list[MarkSpan] = Field(default_factory=list)

    @model_validator(mode="after")
    def _coordinates(self) -> Any:
        fw, fh = (self.frame.width, self.frame.height) if self.frame else (1.0, 1.0)
        for kind, items in (("points", self.points), ("regions", self.regions)):
            for i, item in enumerate(items):
                _check_xy(f"{kind}[{i}]", item, fw, fh)
        for i, item in enumerate(self.spans):
            _check_xy(f"spans[{i}]", item, fw, fh)
        return self

    def norm(self, x: float, y: float) -> tuple[float, float]:
        """A position as fractions of the frame."""
        if self.frame:
            return x / self.frame.width, y / self.frame.height
        return x, y


def _check_xy(where: str, item: Any, fw: float, fh: float) -> None:
    box = item.box if isinstance(item, _Box) else (item.x, item.y, 0.0, 0.0)
    if box is None:
        return
    x, y, w, h = box
    tol = 1e-6
    if x < -tol or y < -tol or x + w > fw * (1 + tol) + tol or y + h > fh * (1 + tol) + tol:
        unit = "the frame" if fw != 1.0 or fh != 1.0 else "0-1"
        msg = f"{where}: coordinates outside {unit}"
        raise ValueError(msg)


class ActivitySample(BaseModel):
    """One dense video sample: share of pixels changed since the previous sample."""

    t: float
    changed_ratio: float


class VideoTile(BaseModel):
    """Per-tile numbers for videos, so an agent can score without looking."""

    index: int
    t: float
    media_time: float | None
    """Presentation time of the decoded frame (``None`` if the browser did not say)."""
    black: bool
    blank: bool
    """One flat colour that is not black (e.g. a white page before load)."""
    duplicate: bool
    """Near-identical to the previous tile (changes < 0.05% of pixels)."""
    sharpness: float
    """Mean luma gradient (0-510); compare tiles of one video: drops = blur/upscaling."""
    marks: list[str]
    """Labels of the marks active on this tile."""


class VideoInfo(BaseModel):
    """Media facts and dense-sample metrics of a video or animated image."""

    container: str
    """``mp4``, ``mov``, ``webm``, ``mkv``, ``gif`` or ``webp``."""
    codec: str | None
    """``h264``, ``hevc``, ``vp8``, ``vp9``, ``av1``, ``gif``, ``webp``, ... if detectable."""
    decoder: Literal["video", "image-decoder"]
    width: int
    height: int
    media_duration: float | None
    fps: float | None
    frame_count: int | None
    start: float
    end: float
    static_threshold: float
    """Seconds without visible change that count as a static stretch."""
    samples: list[ActivitySample]
    """Every sampled time in ``[start, end]`` (tiles + dense grid), in order."""
    tiles: list[VideoTile]


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
    video: VideoInfo | None = None
    """Media facts and per-tile metrics (video inputs only)."""
    marks: Marks | None = None
    """The marks drawn onto the sheet (``--marks``), as given."""

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
        if v := self.video:
            facts = f"{v.container} {v.codec or '?'} {v.width}x{v.height}"
            if v.fps:
                facts += f" {v.fps:g}fps"
            if v.frame_count:
                facts += f", {v.frame_count} frames"
            lines.append(f"video: {facts}; range {v.start:g}-{v.end:g}s, {len(v.samples)} samples")
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
            f"  sheet    {self.images.sheet}  "
            + ("(tiles over the range + timeline)" if self.video else "(motion over one cycle)"),
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


def marks_schema() -> dict[str, Any]:
    """JSON Schema of ``marks.json`` (``--marks``), shared with the npm package (``schema/``).

    Cross-field rules (box all-or-none, ``end >= start``, coordinates inside the frame)
    are enforced by both implementations' validators and documented in the description.
    """
    schema = Marks.model_json_schema(mode="validation")
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": "https://github.com/phil65/framesheet/schema/marks.schema.json",
        **schema,
        "description": (
            "framesheet marks: annotations drawn onto video contact-sheet tiles and the "
            "timeline. Times in seconds of the media. Coordinates are fractions (0-1) of "
            "the video frame, or pixels of `frame` if given. A box (x, y, w, h) is all or "
            "nothing; end >= start; boxes and points must lie inside the frame."
        ),
    }
