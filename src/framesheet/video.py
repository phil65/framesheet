"""Video and animated-image inputs: exact seeks, dense samples, pacing checks.

Seek exact media times in Chromium, sample densely, check pacing (static stretches,
black/blank frames, cuts, mark overlaps), compose the sheet with marks and a timeline.
Ported 1:1 in ``js/src/video.ts``.
"""

from __future__ import annotations

from importlib.resources import files
import math
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal

from PIL import ImageChops

from framesheet import compose, marks as marklib, media
from framesheet.models import (
    ActivitySample,
    DurationInfo,
    Finding,
    Images,
    InspectionResult,
    LoopInfo,
    Marks,
    VideoInfo,
    VideoTile,
    as_rect,
)
from framesheet.render import Session
from framesheet.sources import DEFAULT_HTML_SIZE, VIDEO_ORIGIN, VIDEO_PAGE


if TYPE_CHECKING:
    from collections.abc import Sequence

    from PIL import Image

    from framesheet.sources import Source

VIDEO_JS = files("framesheet").joinpath("video.js").read_text(encoding="utf-8")
STATIC_RATIO = 0.0005
"""A sample step changing fewer than 0.05% of pixels counts as "no visible change"."""
UNIFORM_SHARE = 0.995
"""A frame is black/blank if this share of pixels has one colour (4 bits per channel)."""
CUT_RATIO = 0.4
"""A step changing at least 40% of pixels ..."""
CUT_NEIGHBOUR = 0.25
"""... while both neighbouring steps change at most a quarter of that is an abrupt cut."""
SAMPLE_STEP = 0.25
"""Dense samples are at most this far apart (seconds), up to MAX_SAMPLES."""
MAX_SAMPLES = 240
MAX_TILES = 100
MAX_LISTED = 8
DEFAULT_STATIC_STRETCH = 2.0


def plan_times(
    total: float,
    *,
    start: float | None = None,
    end: float | None = None,
    frames: int = 12,
    every: float | None = None,
    times: Sequence[float] | Literal["marks"] | None = None,
    marks: Marks | None = None,
) -> tuple[float, float, list[float], str]:
    """Range and tile times: ``(start, end, times, mode)``."""
    a = 0.0 if start is None else float(start)
    b = total if end is None else float(end)
    if a < 0 or b <= a or b > total + 1e-6:
        msg = f"Invalid range {a:g}-{b:g}s (the media is {total:g}s long)"
        raise ValueError(msg)
    b = min(b, total)
    if times == "marks":
        if marks is None:
            msg = "times='marks' needs marks"
            raise ValueError(msg)
        ts = [p.t for p in marks.points]
        ts += [(r.start + r.end) / 2 for r in marks.regions]
        ts += [(s.start + s.end) / 2 for s in marks.spans]
        ts = [t for t in ts if a <= t <= b]
        if not ts:
            msg = "No mark falls inside the inspected range"
            raise ValueError(msg)
        mode = "times from marks"
    elif times is not None:
        ts = [float(t) for t in times]
        if not ts:
            msg = "times must not be empty"
            raise ValueError(msg)
        if bad := [t for t in ts if not a <= t <= b]:
            msg = f"Times outside the range {a:g}-{b:g}s: {', '.join(f'{t:g}' for t in bad)}"
            raise ValueError(msg)
        mode = "--times"
    elif every is not None:
        if every <= 0:
            msg = "every must be positive"
            raise ValueError(msg)
        n = math.floor((b - a) / every + 1e-9) + 1
        if n > MAX_TILES:
            msg = f"every={every:g}s gives {n} tiles (max {MAX_TILES})"
            raise ValueError(msg)
        ts = [a + k * every for k in range(n)]
        if b - ts[-1] > 1e-6:  # noqa: PLR2004
            ts.append(b)
        mode = f"every {every:g}s"
    else:
        if not 2 <= frames <= MAX_TILES:  # noqa: PLR2004
            msg = "frames must be between 2 and 100"
            raise ValueError(msg)
        ts = [a + (b - a) * i / (frames - 1) for i in range(frames)]
        ts[-1] = b
        mode = "evenly spaced"
    out = sorted({round(t, 4) for t in ts})
    if len(out) > MAX_TILES:
        msg = f"{len(out)} tiles (max {MAX_TILES})"
        raise ValueError(msg)
    return a, b, out, mode


def dense_times(start: float, end: float, heat_frames: int) -> list[float]:
    """Evenly spaced pacing samples over ``[start, end]`` (both ends included)."""
    if heat_frames <= 0:
        return []
    count = min(MAX_SAMPLES, max(heat_frames, math.ceil((end - start) / SAMPLE_STEP)))
    return [round(start + (end - start) * k / count, 4) for k in range(count + 1)]


def frame_stats(image: Image.Image) -> tuple[bool, bool]:
    """``(black, blank)``: one colour (4 bits/channel) covers >= 99.5% of the pixels."""
    quantized = image.point(lambda v: v >> 4)
    colors = quantized.getcolors(4096) or []
    count, rgb = max(colors)
    uniform = count / (image.width * image.height) >= UNIFORM_SHARE
    black = uniform and isinstance(rgb, tuple) and max(rgb) <= 1
    return black, uniform and not black


def sharpness(image: Image.Image) -> float:
    """Mean absolute luma gradient (``|dx| + |dy|`` per pixel, 0-510)."""
    luma = image.convert("L")
    w, h = luma.size
    total = 0
    if w > 1:
        dx = ImageChops.difference(luma.crop((1, 0, w, h)), luma.crop((0, 0, w - 1, h)))
        total += sum(i * c for i, c in enumerate(dx.histogram()))
    if h > 1:
        dy = ImageChops.difference(luma.crop((0, 1, w, h)), luma.crop((0, 0, w, h - 1)))
        total += sum(i * c for i, c in enumerate(dy.histogram()))
    return round(total / (w * h), 3)


def static_stretches(
    samples: Sequence[ActivitySample], threshold: float
) -> list[tuple[float, float]]:
    """Maximal runs of sample steps without visible change lasting > ``threshold`` s."""
    out = []
    run_start: int | None = None
    for k in range(1, len(samples) + 1):
        still = k < len(samples) and samples[k].changed_ratio < STATIC_RATIO
        if still and run_start is None:
            run_start = k - 1
        elif not still and run_start is not None:
            a, b = samples[run_start].t, samples[k - 1].t
            if b - a > threshold:
                out.append((a, b))
            run_start = None
    return out


def abrupt_cuts(samples: Sequence[ActivitySample]) -> list[float]:
    """Sample times where one step changes >= CUT_RATIO and its neighbours little."""
    out = []
    n = len(samples)
    for k in range(1, n):
        r = samples[k].changed_ratio
        prev = samples[k - 1].changed_ratio if k >= 2 else 0.0  # noqa: PLR2004
        nxt = samples[k + 1].changed_ratio if k + 1 < n else 0.0
        if r >= CUT_RATIO and prev <= r * CUT_NEIGHBOUR and nxt <= r * CUT_NEIGHBOUR:
            out.append(samples[k].t)
    return out


def _runs(times: Sequence[float], flags: dict[float, bool]) -> list[tuple[float, float]]:
    """Consecutive flagged sample times -> ``(first, last)`` runs."""
    out: list[tuple[float, float]] = []
    current: list[float] = []
    for t in times:
        if flags[t]:
            current.append(t)
        elif current:
            out.append((current[0], current[-1]))
            current = []
    if current:
        out.append((current[0], current[-1]))
    return out


def _listed(times: Sequence[float]) -> str:
    text = ", ".join(f"{t:.2f}s" for t in times[:MAX_LISTED])
    return text + (f" (+{len(times) - MAX_LISTED} more)" if len(times) > MAX_LISTED else "")


def mark_overlaps(marks: Marks, start: float, end: float) -> list[Finding]:
    """Span boxes (captions) covering ``target`` region boxes while both are active."""
    out = []
    for s in marks.spans:
        for r in marks.regions:
            if s.box is None or r.box is None or r.kind != "target":
                continue
            a, b = max(s.start, r.start, start), min(s.end, r.end, end)
            if a > b:
                continue
            sx, sy = marks.norm(s.box[0], s.box[1])
            sx2, sy2 = marks.norm(s.box[0] + s.box[2], s.box[1] + s.box[3])
            rx, ry = marks.norm(r.box[0], r.box[1])
            rx2, ry2 = marks.norm(r.box[0] + r.box[2], r.box[1] + r.box[3])
            iw, ih = min(sx2, rx2) - max(sx, rx), min(sy2, ry2) - max(sy, ry)
            if iw <= 0 or ih <= 0:
                continue
            share = iw * ih / ((rx2 - rx) * (ry2 - ry))
            out.append(
                Finding(
                    severity="warning",
                    code="video-mark-overlap",
                    message=f'Span "{s.label}" covers target "{r.label or "target"}" for '
                    f"t={a:.2f}-{b:.2f}s ({share:.0%} of the target box).",
                    check="render",
                    times=[round(a, 4), round(b, 4)],
                )
            )
    return out


def video_findings(
    samples: Sequence[ActivitySample],
    stats: dict[float, tuple[bool, bool]],
    threshold: float,
    marks: Marks | None,
    start: float,
    end: float,
) -> tuple[list[Finding], list[dict[str, Any]]]:
    """Findings plus timeline issues (``{"kind", "start", "end"}``)."""
    findings: list[Finding] = []
    issues: list[dict[str, Any]] = []
    for a, b in static_stretches(samples, threshold):
        findings.append(
            Finding(
                severity="warning",
                code="video-static-stretch",
                message=f"No visible change for {b - a:.2f}s (t={a:.2f}-{b:.2f}s; under "
                f"{STATIC_RATIO:.2%} of pixels per sample): dead time?",
                check="render",
                times=[a, b],
            )
        )
        issues.append({"kind": "static", "start": a, "end": b})
    times = [s.t for s in samples]
    for kind, index, what in (("black", 0, "black"), ("blank", 1, "one flat colour (blank)")):
        flags = {t: stats[t][index] for t in times}
        hits = [t for t in times if flags[t]]
        if not hits:
            continue
        findings.append(
            Finding(
                severity="warning",
                code=f"video-{kind}-frames",
                message=f"{len(hits)} sampled frame(s) are {what}: t={_listed(hits)}.",
                check="render",
                times=hits,
            )
        )
        issues += [{"kind": kind, "start": a, "end": b} for a, b in _runs(times, flags)]
    if cuts := abrupt_cuts(samples):
        findings.append(
            Finding(
                severity="info",
                code="video-abrupt-cut",
                message=f"Abrupt change (>= {CUT_RATIO:.0%} of pixels in one sample step, "
                f"quiet neighbours) at t={_listed(cuts)}: a hard cut or a jump.",
                check="render",
                times=cuts,
            )
        )
        issues += [{"kind": "cut", "start": t, "end": t} for t in cuts]
    if marks is not None:
        findings += mark_overlaps(marks, start, end)
    issues.sort(key=lambda i: (i["start"], i["kind"]))
    return findings, issues


def decode_hint(label: str, probe: media.Probe, error: str) -> str:
    codec = probe.codec or "unknown codec"
    return (
        f"Chromium could not decode {label} ({probe.container}/{codec}): {error}. "
        "Playwright's Chromium may lack proprietary codecs (H.264/HEVC): re-encode to "
        "WebM/VP9 (ffmpeg -i in.mp4 -c:v libvpx-vp9 -crf 32 -b:v 0 out.webm) or use an "
        "installed Chrome (--channel chrome)."
    )


def tile_label(t: float, i: int, count: int, start: float, end: float) -> str:
    label = f"t={t:.2f}s"
    if i == 0 and t == start:
        return f"{label}  start"
    if i == count - 1 and t == end:
        return f"{label}  end"
    return label


def inspect_video(
    src: Source,
    *,
    out_dir: Path,
    frames: int,
    duration: float | None,
    size: tuple[int, int] | None,
    scale: float | None,
    at: float | None,
    tile: int | None,
    columns: int | None,
    keep_frames: bool,
    heat_frames: int,
    timeout: float,
    every: float | None,
    times: Sequence[float] | Literal["marks"] | None,
    start: float | None,
    end: float | None,
    marks: Marks | None,
    static_stretch: float,
    channel: str | None,
) -> InspectionResult:
    from playwright.sync_api import Error

    from framesheet.core import auto_scale, frame_metrics, motion_findings

    assert src.media is not None
    probe = media.probe(src.media, src.container)
    viewport = size or (
        (probe.width, probe.height) if probe.width and probe.height else DEFAULT_HTML_SIZE
    )
    dsf = scale or (1.0 if size else auto_scale(viewport))
    routes = {
        f"{VIDEO_ORIGIN}/video.html": (VIDEO_PAGE.encode(), "text/html; charset=utf-8"),
        f"{VIDEO_ORIGIN}/media": (src.media, probe.mime),
    }
    decoder = "image-decoder" if probe.animated_image else "video"
    with Session(
        src, size=viewport, scale=dsf, timeout=timeout, clock=False, routes=routes,
        channel=channel,
    ) as s:  # fmt: skip
        s.goto()
        s.js(VIDEO_JS)
        try:
            loaded = s.js(
                "([src, d, t]) => window.__framesheetVideo.load(src, d, t)",
                ["/media", decoder, probe.mime],
            )
        except Error as exc:
            raise ValueError(decode_hint(src.label, probe, str(exc).splitlines()[0])) from None
        width, height = int(loaded["width"]), int(loaded["height"])
        if not size and (width, height) != viewport:
            viewport = (width, height)
            s.page.set_viewport_size({"width": width, "height": height})
        media_duration = loaded["duration"]
        if media_duration is not None:
            media_duration = round(float(media_duration), 4)
        total = duration or media_duration
        if not total:
            msg = f"Unknown media duration of {src.label}: pass --duration"
            raise ValueError(msg)
        a, b, tile_times, mode = plan_times(
            total, start=start, end=end, frames=frames, every=every, times=times, marks=marks
        )
        full_at = a if at is None else round(at, 4)
        if not 0 <= full_at <= total:
            msg = f"--at {full_at:g}s is outside the media (0-{total:g}s)"
            raise ValueError(msg)
        content = as_rect(s.js("() => window.__framesheetVideo.contentBox()"))
        wanted = set(tile_times) | {full_at}
        everything = sorted(wanted | set(dense_times(a, b, heat_frames)))
        kept: dict[float, Image.Image] = {}
        media_times: dict[float, float | None] = {}
        samples: list[ActivitySample] = []
        stats: dict[float, tuple[bool, bool]] = {}
        acc = compose.MotionAccumulator()
        prev: Image.Image | None = None
        for t in everything:
            mt = s.js("t => window.__framesheetVideo.seek(t)", t)
            media_times[t] = None if mt is None else round(float(mt), 4)
            image = s.capture()
            if t in wanted:
                kept[t] = image
            if a <= t <= b:
                ratio = compose.diff_stats(prev, image)[0] if prev is not None else 0.0
                samples.append(ActivitySample(t=t, changed_ratio=round(ratio, 5)))
                stats[t] = frame_stats(image)
                acc.add(image)
                prev = image
        console_errors = list(s.console_errors)

    tile_images = [kept[t] for t in tile_times]
    metrics = frame_metrics(tile_images, tile_times, dsf)
    moving = any(smp.changed_ratio > 0 for smp in samples)
    info = DurationInfo(
        seconds=total,
        method="override" if duration else "media",
        looping=False,
        detail=(
            f"--duration {duration:g}s"
            + (f" (media reports {media_duration:g}s)" if media_duration else "")
            if duration
            else f"media duration {total:g}s"
        ),
    )
    findings, issues = video_findings(samples, stats, static_stretch, marks, a, b)
    findings += motion_findings(info, moving)
    findings += [
        Finding(severity="warning", code="console-error", message=msg, check="render")
        for msg in console_errors[:5]
    ]
    order = {"error": 0, "warning": 1, "info": 2}
    findings.sort(key=lambda f: order[f.severity])

    windows = marklib.tile_windows(tile_times, a, b)
    n = len(tile_times)
    tiles = [
        VideoTile(
            index=i,
            t=t,
            media_time=media_times[t],
            black=stats[t][0],
            blank=stats[t][1],
            duplicate=i > 0 and metrics[i].changed_ratio < STATIC_RATIO,
            sharpness=sharpness(tile_images[i]),
            marks=marklib.active_labels(marks, t, windows[i], i == n - 1) if marks else [],
        )
        for i, t in enumerate(tile_times)
    ]
    video = VideoInfo(
        container=probe.container,
        codec=probe.codec,
        decoder=decoder,
        width=width,
        height=height,
        media_duration=media_duration,
        fps=loaded["fps"] if loaded["fps"] is not None else probe.fps,
        frame_count=loaded["frame_count"]
        if loaded["frame_count"] is not None
        else probe.frame_count,
        start=a,
        end=b,
        static_threshold=static_stretch,
        samples=samples,
        tiles=tiles,
    )
    title = Path(src.label).name
    facts = f"{video.container}/{video.codec or '?'} {width}x{height}"
    if video.fps:
        facts += f" {video.fps:g} fps"
    labels = [tile_label(t, i, n, a, b) for i, t in enumerate(tile_times)]
    highlight = [i for i in (0, n - 1) if labels[i].endswith(("start", "end"))]

    def overlay(i: int, thumb: tuple[int, int]) -> list[compose.DrawOp]:
        if marks is None:
            return []
        return marklib.tile_ops(
            marks, tile_times[i], windows[i], i == n - 1, size=thumb, viewport=viewport,
            content=content,
        )  # fmt: skip

    def footer(width_px: int) -> tuple[int, list[compose.DrawOp]]:
        activity = [(smp.t, smp.changed_ratio) for smp in samples]
        return marklib.timeline_ops(
            width_px, a, b, tile_times, marks=marks, activity=activity, issues=issues
        )

    sheet = compose.contact_sheet(
        tile_images,
        labels,
        title=title,
        subtitle=f"{n} tiles over {a:g}-{b:g}s ({mode}); {facts}",
        tile=tile,
        columns=columns,
        highlight=highlight,
        bands=[marklib.band_text(marks, t) for t in tile_times]
        if marks and marklib.has_band(marks)
        else None,
        overlay=overlay if marks else None,
        footer=footer,
    )
    assert acc.first is not None
    assert acc.acc is not None
    heat = compose.heatmap_from(
        acc.first,
        acc.acc,
        title=f"{title}: motion heatmap",
        subtitle=f"pixels that change across {acc.count} frames over {a:g}-{b:g}s; "
        f"background = t={a:g}s, dimmed",
        boxes=[acc.box] if acc.box else [],
    )
    paths = Images(
        full=compose.save_png(kept[full_at], out_dir / "full.png"),
        sheet=compose.save_png(sheet, out_dir / "sheet.png"),
        heatmap=compose.save_png(heat, out_dir / "heatmap.png"),
        report=out_dir / "report.json",
    )
    if keep_frames:
        for m, image in zip(metrics, tile_images):
            m.path = compose.save_png(image, out_dir / "frames" / f"frame_{m.index:03d}.png")
    result = InspectionResult(
        source=src.label,
        kind="video",
        viewport=viewport,
        device_scale_factor=dsf,
        canvas=content,
        duration=info,
        times=tile_times,
        full_at=full_at,
        images=paths,
        findings=findings,
        frames=metrics,
        elements=[],
        loop=LoopInfo(checked=False, detail="not checked for video input"),
        console_errors=console_errors,
        video=video,
        marks=marks,
    )
    paths.report.write_text(result.model_dump_json(indent=2), encoding="utf-8")
    return result
