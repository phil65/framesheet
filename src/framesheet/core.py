"""The :func:`inspect` pipeline: load, detect duration, sample, check, compose."""

from __future__ import annotations

import itertools
import math
from pathlib import Path
import tempfile
from typing import TYPE_CHECKING, Any, Literal

from framesheet import analysis, checks, compose, sources, timing
from framesheet.models import (
    ColorScheme,
    DurationInfo,
    Finding,
    FrameMetrics,
    Images,
    InspectionResult,
    LoopInfo,
    Marks,
    Severity,
    as_rect,
)
from framesheet.render import Session, Snapshot


if TYPE_CHECKING:
    from collections.abc import Sequence

    from PIL import Image

SEAM_MIN_RATIO = 0.002
"""A seam changing fewer than 0.2% of pixels always counts as seamless."""
SEAM_STEP_FACTOR = 3
"""A seam is a jump if it changes this many times more pixels than one normal step."""
MIN_AUTO_SIDE = 400
MAX_CONSOLE_ERRORS = 5
_SEVERITY_ORDER = {"error": 0, "warning": 1, "info": 2}


def _auto_scale(size: tuple[int, int]) -> float:
    """Tiny SVGs (icons) get a higher device scale factor so frames stay legible."""
    longest = max(size)
    return float(min(8, math.ceil(MIN_AUTO_SIDE / longest))) if longest < MIN_AUTO_SIDE else 1.0


def _resolve(source: str | Path, workdir: Path) -> sources.Source:
    if isinstance(source, str) and source.lstrip().startswith("<"):
        return sources.snippet(source, workdir)
    return sources.resolve(source, workdir)


def inspect(
    source: str | Path,
    *,
    frames: int = 12,
    duration: float | None = None,
    size: tuple[int, int] | None = None,
    scale: float | None = None,
    at: float | None = None,
    out: str | Path | None = None,
    tile: int | None = None,
    columns: int | None = None,
    keep_frames: bool = False,
    heat_frames: int = 48,
    color_scheme: ColorScheme = "light",
    timeout: float = 30.0,
    every: float | None = None,
    times: Sequence[float] | Literal["marks"] | None = None,
    start: float | None = None,
    end: float | None = None,
    marks: str | Path | dict[str, Any] | Marks | None = None,
    static_stretch: float = 2.0,
    channel: str | None = None,
) -> InspectionResult:
    """Render an animated SVG/HTML (or a video) at evenly spaced times and check it.

    Args:
        source: Path to an ``.svg``/``.html`` file or a video (``.mp4``, ``.webm``,
            ``.mov``, ``.mkv``, animated ``.gif``/``.webp``), an ``http(s)://`` URL, ``-``
            for stdin, or a markup string starting with ``<``.
        frames: Number of contact-sheet tiles (2-100), spread over one cycle.
        duration: Cycle length in seconds; detected from SMIL/CSS/Web Animations if omitted.
        size: Viewport ``(width, height)`` in CSS px (default: SVG size/viewBox, or 1280x720).
        scale: Device scale factor (default 1; tiny SVGs without ``size`` get more).
        at: Time in seconds of the full-resolution frame ``full.png``.
        out: Output directory (default: a new temporary directory).
        tile: Longest side of a contact-sheet tile in px (default: fit 1568 px width).
        columns: Contact-sheet columns (default: roughly 4:3 sheet).
        keep_frames: Also write every sampled frame to ``frames/``.
        heat_frames: Extra evenly spaced frames (pixels only) for a continuous heatmap
            trail; 0 uses only the contact-sheet frames.
        color_scheme: ``light`` or ``dark`` (``prefers-color-scheme``).
        timeout: Seconds to wait for navigation and page scripts.
        every: Videos: one tile every this many seconds (instead of ``frames``).
        times: Videos: explicit tile times (seconds), or ``"marks"`` for each point's
            ``t`` and each region's/span's midpoint.
        start: Videos: start of the inspected range (default 0).
        end: Videos: end of the inspected range (default: the media duration).
        marks: Videos: marks to draw (path, JSON string, dict or :class:`Marks`).
        static_stretch: Videos: seconds without visible change reported as
            ``video-static-stretch``.
        channel: Browser channel for Playwright (e.g. ``chrome`` for H.264 if the bundled
            Chromium lacks it).

    Returns:
        Paths of the written images plus metrics and findings.
    """
    if not 2 <= frames <= 100:  # noqa: PLR2004
        msg = "frames must be between 2 and 100"
        raise ValueError(msg)
    if duration is not None and duration <= 0:
        msg = "duration must be positive"
        raise ValueError(msg)
    out_dir = Path(out) if out else Path(tempfile.mkdtemp(prefix="framesheet-"))
    out_dir.mkdir(parents=True, exist_ok=True)
    src = _resolve(source, out_dir)
    if src.kind == "video":
        from framesheet.marks import load_marks
        from framesheet.video import inspect_video

        if static_stretch <= 0:
            msg = "static_stretch must be positive"
            raise ValueError(msg)
        return inspect_video(
            src,
            out_dir=out_dir,
            frames=frames,
            duration=duration,
            size=size,
            scale=scale,
            at=at,
            tile=tile,
            columns=columns,
            keep_frames=keep_frames,
            heat_frames=heat_frames,
            timeout=timeout,
            every=every,
            times=times,
            start=start,
            end=end,
            marks=load_marks(marks) if marks is not None else None,
            static_stretch=static_stretch,
            channel=channel,
        )
    video_only = {"every": every, "times": times, "start": start, "end": end, "marks": marks}
    if given := [name for name, value in video_only.items() if value is not None]:
        msg = f"{', '.join(given)}: only for video inputs"
        raise ValueError(msg)
    at = 0.0 if at is None else at
    viewport = size or sources.default_size(src)
    dsf = scale or (1.0 if size else _auto_scale(viewport))

    with Session(
        src, size=viewport, scale=dsf, color_scheme=color_scheme, timeout=timeout, channel=channel
    ) as s:
        s.load()
        text = src.text if src.text is not None else s.response_text
        findings = _static_findings(src.kind, text)
        animations = timing.parse_timings(s.js("() => window.__framesheet.timings()"))
        info = timing.detect_duration(animations, duration)
        times = timing.sample_times(info.seconds, frames)
        eps = timing.epsilon(info.seconds)
        description = s.js("() => window.__framesheet.describe()")
        targets = s.js("() => window.__framesheet.animatedTargets()")
        canvas = as_rect(s.js("() => window.__framesheet.canvasRect()"))
        viewbox = s.js("() => window.__framesheet.viewBox()")
        is_svg_doc = bool(s.js("() => window.__framesheet.isSvgDoc"))
        snaps: dict[float, Snapshot] = {}
        heat: dict[float, Image.Image] = {}
        measured = {*times, round(eps, 4), at}
        extra = {round(info.seconds * i / heat_frames, 4) for i in range(heat_frames)}
        for t in sorted(measured | extra):
            if t in measured:
                snaps[t] = s.snapshot(t, overflow=src.kind == "html")
                heat[t] = snaps[t].image
            else:
                heat[t] = s.screenshot(t)
        console_errors = list(s.console_errors)

    sheet_snaps = [snaps[t] for t in times]
    images = [snap.image for snap in sheet_snaps]
    metrics = _frame_metrics(images, times, dsf)
    moving = any(m.changed_ratio > 0 for m in metrics)
    findings += _motion_findings(info, moving)
    loop = _loop_info(
        info, moving, snaps[times[0]].image, snaps[round(eps, 4)].image, images[-1], dsf
    )
    if loop.checked and loop.seamless is False:
        findings.append(
            Finding(
                severity="warning",
                code="non-seamless-loop",
                message=f"The loop jumps at the cycle end: {loop.detail}.",
                check="render",
                times=[times[-1], 0.0],
            )
        )
    geo = analysis.Geometry.build(
        description,
        sheet_snaps,
        canvas=canvas,
        viewbox=as_rect(viewbox) if viewbox else None,
        targets=targets,
        animations=animations,
        is_svg_doc=is_svg_doc,
    )
    findings += analysis.run_checks(geo)
    findings += [
        Finding(severity="warning", code="console-error", message=msg, check="render")
        for msg in console_errors[:MAX_CONSOLE_ERRORS]
    ]
    findings.sort(key=lambda f: _SEVERITY_ORDER[f.severity])

    heat_images = [heat[t] for t in sorted(heat) if t <= times[-1]]
    paths = _write_images(
        out_dir,
        src.label,
        info,
        times,
        sheet_snaps,
        heat_images,
        snaps[at].image,
        tile,
        columns,
        keep_frames,
    )
    if keep_frames:
        for m in metrics:
            m.path = out_dir / "frames" / f"frame_{m.index:03d}.png"
    result = InspectionResult(
        source=src.label,
        kind=src.kind,
        viewport=viewport,
        device_scale_factor=dsf,
        canvas=canvas,
        duration=info,
        times=times,
        full_at=at,
        images=paths,
        findings=findings,
        frames=metrics,
        elements=analysis.tracks(geo),
        loop=loop,
        console_errors=console_errors,
    )
    paths.report.write_text(result.model_dump_json(indent=2), encoding="utf-8")
    return result


def _static_findings(kind: str, text: str | None) -> list[Finding]:
    if not text:
        return []
    if kind == "svg":
        return checks.check_svg_source(text)
    return checks.check_html_source(text)


def _frame_metrics(
    images: list[Image.Image], times: list[float], scale: float
) -> list[FrameMetrics]:
    out = [FrameMetrics(index=0, t=times[0], changed_ratio=0.0)]
    for i in range(1, len(images)):
        ratio, box = compose.diff_stats(images[i - 1], images[i])
        out.append(
            FrameMetrics(
                index=i,
                t=times[i],
                changed_ratio=round(ratio, 5),
                changed_box=compose.to_css(box, scale),
            )
        )
    return out


def _motion_findings(info: DurationInfo, moving: bool) -> list[Finding]:
    def finding(severity: Severity, code: str, message: str) -> Finding:
        return Finding(severity=severity, code=code, message=message, check="render")

    if info.method == "fallback" and moving:
        info.looping = True
        return [
            finding(
                "warning",
                "js-driven-motion",
                "Pixels change but no SMIL/CSS/Web Animation was found: motion is JS-driven "
                f"(rAF/canvas/timers). Sampled {info.seconds:g}s; pass --duration with the "
                "real cycle length.",
            )
        ]
    if not moving and info.animations:
        return [
            finding(
                "info",
                "no-visible-motion",
                f"{len(info.animations)} animation(s) declared, but no pixel changed between "
                "sampled frames.",
            )
        ]
    if not moving:
        return [finding("info", "no-motion", "No animation found and no pixel changed: static.")]
    return []


def _loop_info(
    info: DurationInfo,
    moving: bool,
    first: Image.Image,
    after_first: Image.Image,
    last: Image.Image,
    scale: float,
) -> LoopInfo:
    if not moving:
        return LoopInfo(checked=False, detail="no motion")
    if not info.looping:
        return LoopInfo(checked=False, detail="finite animation (does not repeat)")
    if info.method == "fallback":
        return LoopInfo(checked=False, detail="cycle length unknown (JS-driven); pass --duration")
    seam, box = compose.diff_stats(last, first)
    step, _ = compose.diff_stats(first, after_first)
    seamless = seam <= SEAM_MIN_RATIO or seam <= SEAM_STEP_FACTOR * step + SEAM_MIN_RATIO / 2
    detail = (
        f"last frame -> first frame changes {seam:.2%} of pixels, "
        f"one normal step changes {step:.2%}"
    )
    return LoopInfo(
        checked=True,
        seamless=seamless,
        seam_ratio=round(seam, 5),
        step_ratio=round(step, 5),
        seam_box=compose.to_css(box, scale) if not seamless else None,
        detail=detail,
    )


def _label(t: float, i: int, count: int) -> str:
    label = f"t={t:.2f}s"
    if i == 0:
        return f"{label}  start"
    if i == count - 1:
        return f"{label}  end"
    return label


def _write_images(
    out_dir: Path,
    name: str,
    info: DurationInfo,
    times: list[float],
    snaps: list[Snapshot],
    heat_images: list[Image.Image],
    full: Image.Image,
    tile: int | None,
    columns: int | None,
    keep_frames: bool,
) -> Images:
    images = [s.image for s in snaps]
    title = Path(name).name if name not in {"-", "<snippet>"} else "stdin"
    span = f"{len(times)} frames over 0-{info.seconds:g}s"
    how = {"override": "set by --duration", "detected": "detected", "fallback": "fallback"}
    loop = "looping" if info.looping else "not looping"
    sheet = compose.contact_sheet(
        images,
        [_label(t, i, len(times)) for i, t in enumerate(times)],
        title=title,
        subtitle=f"{span} ({how[info.method]}, {loop}); last tile = 1 frame before the end",
        tile=tile,
        columns=columns,
        highlight=(0, len(images) - 1),
    )
    union = None
    for prev, cur in itertools.pairwise(heat_images):
        _, box = compose.diff_stats(prev, cur)
        if box:
            union = box if union is None else _union(union, box)
    heat = compose.heatmap(
        heat_images,
        title=f"{title}: motion heatmap",
        subtitle=f"pixels that change across {len(heat_images)} frames over 0-{info.seconds:g}s"
        "; background = t=0, dimmed",
        boxes=[union] if union else [],
    )
    paths = Images(
        full=compose.save_png(full, out_dir / "full.png"),
        sheet=compose.save_png(sheet, out_dir / "sheet.png"),
        heatmap=compose.save_png(heat, out_dir / "heatmap.png"),
        report=out_dir / "report.json",
    )
    if keep_frames:
        for i, image in enumerate(images):
            compose.save_png(image, out_dir / "frames" / f"frame_{i:03d}.png")
    return paths


def _union(a: tuple[int, int, int, int], b: tuple[int, int, int, int]) -> tuple[int, int, int, int]:
    return min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3])


auto_scale = _auto_scale
frame_metrics = _frame_metrics
motion_findings = _motion_findings
