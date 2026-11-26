"""Image composition with Pillow: contact sheet, motion heatmap, pixel diffs."""

from functools import cache
import itertools
import math
from typing import TYPE_CHECKING, Any

from PIL import Image, ImageChops, ImageDraw, ImageFont


if TYPE_CHECKING:
    from collections.abc import Callable, Sequence
    from pathlib import Path

    from framesheet.models import Rect

DIFF_THRESHOLD = 8
"""Per-channel difference (0-255) below which a pixel counts as unchanged."""
SHEET_BG = (226, 228, 233)
INK = (17, 24, 39)
MUTED = (75, 85, 99)
LABEL_BG = (17, 24, 39)
LABEL_FG = (255, 255, 255)
ACCENT_BG = (190, 18, 60)
TILE_BORDER = (100, 116, 139)
BOX_COLOR = (34, 211, 238)
HEADER_H = 66
LABEL_H = 34
GAP = 12
PAD = 12
LABEL_FONT = 22
MARK_BAND_H = 26
MARK_BAND_BG = (51, 65, 85)
MARK_BAND_FG = (253, 230, 138)
MARK_BAND_FONT = 16

DrawOp = dict[str, Any]
"""A layout operation: ``{"op": "rect" | "outline" | "text", ...}`` (see :func:`draw_ops`)."""


@cache
def font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    """Pillow's bundled font: identical on every platform, so output is deterministic."""
    return ImageFont.load_default(size=size)


def save_png(image: Image.Image, path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, format="PNG", optimize=False, compress_level=6)
    return path


def change_mask(a: Image.Image, b: Image.Image) -> Image.Image:
    """``L`` image: per-pixel max channel difference between two RGB frames."""
    r, g, b_ = ImageChops.difference(a, b).split()
    return ImageChops.lighter(ImageChops.lighter(r, g), b_)


def diff_stats(a: Image.Image, b: Image.Image) -> tuple[float, tuple[int, int, int, int] | None]:
    """Share of changed pixels and the bounding box (device px) of the change."""
    mask = change_mask(a, b).point(lambda v: 255 if v > DIFF_THRESHOLD else 0)
    hist = mask.histogram()
    total = a.width * a.height
    return hist[255] / total, mask.getbbox()


def to_css(box: tuple[int, int, int, int] | None, scale: float) -> Rect | None:
    if box is None:
        return None
    x0, y0, x1, y1 = box
    return (
        round(x0 / scale, 1),
        round(y0 / scale, 1),
        round((x1 - x0) / scale, 1),
        round((y1 - y0) / scale, 1),
    )


def _fit(image: Image.Image, max_w: int, max_h: int) -> Image.Image:
    factor = min(max_w / image.width, max_h / image.height)
    size = (max(1, round(image.width * factor)), max(1, round(image.height * factor)))
    return image.resize(size, Image.Resampling.LANCZOS)


def _text_width(draw: ImageDraw.ImageDraw, text: str, size: int) -> float:
    return draw.textlength(text, font=font(size))


def _header(width: int, title: str, subtitle: str) -> Image.Image:
    band = Image.new("RGB", (width, HEADER_H), SHEET_BG)
    draw = ImageDraw.Draw(band)
    draw.text((PAD, 8), title, fill=INK, font=font(24))
    draw.text((PAD, 39), subtitle, fill=MUTED, font=font(18))
    return band


MAX_SHEET_WIDTH = 1568
"""Vision models downscale larger images; keep the sheet at or below this width."""
MAX_TILE = 480


def default_columns(count: int, tile_aspect: float) -> int:
    """Columns that give a landscape (at least ~4:3) sheet for tiles of ``tile_aspect`` (w/h)."""
    cols = math.ceil(math.sqrt(count * 4 / 3 / tile_aspect) - 0.25)
    return max(1, min(count, cols))


def auto_tile(columns: int) -> int:
    """Largest tile that keeps ``columns`` tiles within :data:`MAX_SHEET_WIDTH`."""
    return max(120, min(MAX_TILE, (MAX_SHEET_WIDTH - 24 - (columns - 1) * 12) // columns - 2))


def contact_sheet(
    frames: Sequence[Image.Image],
    labels: Sequence[str],
    *,
    title: str,
    subtitle: str,
    tile: int | None = None,
    columns: int | None = None,
    highlight: Sequence[int] = (),
    bands: Sequence[str] | None = None,
    overlay: Callable[[int, tuple[int, int]], Sequence[DrawOp]] | None = None,
    footer: Callable[[int], tuple[int, Sequence[DrawOp]]] | None = None,
) -> Image.Image:
    """Grid of frames, each with a timestamp label band above it.

    Args:
        frames: Full-resolution frames (all the same size).
        labels: One label per frame (e.g. ``t=0.50s``).
        title: Header line (input name).
        subtitle: Second header line (frames, span, how the duration was found).
        tile: Longest side of a tile in pixels (default: as large as fits 1568 px).
        columns: Grid columns (default: roughly 4:3 sheet).
        highlight: Frame indices whose label gets the accent colour (first/last).
        bands: Optional second label line per frame (active marks), drawn in an extra
            :data:`MARK_BAND_H` band under the timestamp.
        overlay: ``(index, thumb size) -> ops`` drawn over each tile image (relative to
            its top-left).
        footer: ``(sheet width) -> (height, ops)`` appended below the grid (ops relative
            to its top-left).
    """
    first = frames[0]
    aspect = first.width / first.height
    cols = columns or default_columns(len(frames), aspect)
    tile = tile or auto_tile(cols)
    tw, th = (tile, round(tile / aspect)) if aspect >= 1 else (round(tile * aspect), tile)
    rows = math.ceil(len(frames) / cols)
    gap, label_h, pad = GAP, LABEL_H, PAD
    band_h = MARK_BAND_H if bands is not None else 0
    cell_w, cell_h = tw + 2, th + 2 + label_h + band_h
    width = max(pad * 2 + cols * cell_w + (cols - 1) * gap, 560)
    header = _header(width, title, subtitle)
    grid_h = header.height + pad + rows * cell_h + (rows - 1) * gap + pad
    foot = footer(width) if footer else None
    height = grid_h + (foot[0] if foot else 0)
    sheet = Image.new("RGB", (width, height), SHEET_BG)
    sheet.paste(header, (0, 0))
    draw = ImageDraw.Draw(sheet)
    for i, (frame, label) in enumerate(zip(frames, labels)):
        row, col = divmod(i, cols)
        x = pad + col * (cell_w + gap)
        y = header.height + pad + row * (cell_h + gap)
        bg = ACCENT_BG if i in highlight else LABEL_BG
        draw.rectangle((x, y, x + cell_w - 1, y + label_h - 1), fill=bg)
        draw.text((x + 8, y + 5), label, fill=LABEL_FG, font=font(LABEL_FONT))
        index = f"#{i + 1}"
        draw.text(
            (x + cell_w - 8 - _text_width(draw, index, 16), y + 10),
            index,
            fill=(203, 213, 225),
            font=font(16),
        )
        if bands is not None:
            band_y = y + label_h
            draw.rectangle((x, band_y, x + cell_w - 1, band_y + band_h - 1), fill=MARK_BAND_BG)
            draw.text((x + 8, band_y + 4), bands[i], fill=MARK_BAND_FG, font=font(MARK_BAND_FONT))
        top = y + label_h + band_h
        draw.rectangle((x, top, x + cell_w - 1, y + cell_h - 1), outline=TILE_BORDER)
        thumb = _fit(frame, tw, th)
        ix = x + 1 + (tw - thumb.width) // 2
        sheet.paste(thumb, (ix, top + 1))
        if overlay is not None:
            draw_ops(draw, overlay(i, thumb.size), ix, top + 1)
    if foot:
        draw_ops(draw, foot[1], 0, grid_h)
    return sheet


def draw_ops(draw: ImageDraw.ImageDraw, ops: Sequence[DrawOp], dx: int = 0, dy: int = 0) -> None:
    """Execute layout ops (same format as the npm package's DrawOp), offset by ``dx, dy``.

    ``rect``/``outline`` boxes are inclusive ``(x0, y0, x1, y1)``; ``text`` is anchored at
    its top-left (``align: right`` = at its top-right).
    """
    for op in ops:
        kind = op["op"]
        if kind == "rect":
            x0, y0, x1, y1 = op["box"]
            draw.rectangle((x0 + dx, y0 + dy, x1 + dx, y1 + dy), fill=tuple(op["fill"]))
        elif kind == "outline":
            x0, y0, x1, y1 = op["box"]
            draw.rectangle(
                (x0 + dx, y0 + dy, x1 + dx, y1 + dy),
                outline=tuple(op["color"]),
                width=op["width"],
            )
        elif kind == "text":
            x = op["x"] + dx
            if op.get("align") == "right":
                x -= _text_width(draw, op["text"], op["size"])
            draw.text((x, op["y"] + dy), op["text"], fill=tuple(op["color"]), font=font(op["size"]))


def motion_map(frames: Sequence[Image.Image]) -> Image.Image:
    """``L`` image: per-pixel max change between consecutive frames and vs. the first."""
    acc = Image.new("L", frames[0].size, 0)
    for prev, cur in itertools.pairwise(frames):
        acc = ImageChops.lighter(acc, change_mask(prev, cur))
    for cur in frames[1:]:
        acc = ImageChops.lighter(acc, change_mask(frames[0], cur))
    return acc


def _heat_lut() -> tuple[list[int], list[int], list[int], list[int]]:
    """Colour ramp for change strength: violet (subtle) -> red -> orange -> yellow (strong)."""
    stops = [
        (0.0, (168, 85, 247)),
        (0.4, (239, 68, 68)),
        (0.7, (249, 115, 22)),
        (1.0, (253, 230, 80)),
    ]
    red, green, blue, alpha = [], [], [], []
    for v in range(256):
        if v <= DIFF_THRESHOLD:
            red.append(0)
            green.append(0)
            blue.append(0)
            alpha.append(0)
            continue
        s = min(1.0, (v - DIFF_THRESHOLD) / 120) ** 0.5
        for (p0, c0), (p1, c1) in itertools.pairwise(stops):
            if s <= p1:
                f = (s - p0) / (p1 - p0)
                rgb = [round(a + (b - a) * f) for a, b in zip(c0, c1)]
                break
        red.append(rgb[0])
        green.append(rgb[1])
        blue.append(rgb[2])
        alpha.append(round(170 + 85 * s))
    return red, green, blue, alpha


_LUT = _heat_lut()


def heatmap(
    frames: Sequence[Image.Image],
    *,
    title: str,
    subtitle: str,
    max_side: int = 1280,
    min_side: int = 800,
    boxes: Sequence[tuple[int, int, int, int]] = (),
) -> Image.Image:
    """Coloured motion overlay on a dimmed, desaturated first frame.

    Args:
        frames: Full-resolution frames.
        title: Header line.
        subtitle: Second header line.
        max_side: Longest side of the image area (frames are downscaled to fit).
        min_side: Small inputs are upscaled until their longest side reaches this.
        boxes: Device-px boxes to outline (e.g. the overall changed region).
    """
    return heatmap_from(
        frames[0],
        motion_map(frames),
        title=title,
        subtitle=subtitle,
        max_side=max_side,
        min_side=min_side,
        boxes=boxes,
    )


class MotionAccumulator:
    """Incremental :func:`motion_map` (frames fed in order, not kept in memory)."""

    def __init__(self) -> None:
        self.first: Image.Image | None = None
        self.prev: Image.Image | None = None
        self.acc: Image.Image | None = None
        self.box: tuple[int, int, int, int] | None = None
        self.count = 0

    def add(self, frame: Image.Image) -> None:
        self.count += 1
        if self.first is None or self.prev is None or self.acc is None:
            self.first = self.prev = frame
            self.acc = Image.new("L", frame.size, 0)
            return
        step = change_mask(self.prev, frame)
        self.acc = ImageChops.lighter(self.acc, step)
        self.acc = ImageChops.lighter(self.acc, change_mask(self.first, frame))
        box = step.point(lambda v: 255 if v > DIFF_THRESHOLD else 0).getbbox()
        if box:
            b = self.box
            self.box = (
                box
                if b is None
                else (
                    min(b[0], box[0]),
                    min(b[1], box[1]),
                    max(b[2], box[2]),
                    max(b[3], box[3]),
                )
            )
        self.prev = frame


def heatmap_from(
    first: Image.Image,
    motion: Image.Image,
    *,
    title: str,
    subtitle: str,
    max_side: int = 1280,
    min_side: int = 800,
    boxes: Sequence[tuple[int, int, int, int]] = (),
) -> Image.Image:
    """:func:`heatmap` from a precomputed motion map (``L`` image) and the first frame."""
    # Grey, low-contrast base in a fixed dark range so every overlay colour stands out.
    base = first.convert("L").point(lambda v: round(28 + v * 0.32)).convert("RGB")
    red, green, blue, alpha = _LUT
    overlay = Image.merge(
        "RGBA",
        (motion.point(red), motion.point(green), motion.point(blue), motion.point(alpha)),
    )
    composed = base.convert("RGBA")
    composed.alpha_composite(overlay)
    image = composed.convert("RGB")
    draw = ImageDraw.Draw(image)
    stroke = max(2, round(max(image.size) / 300))
    for box in boxes:
        draw.rectangle(box, outline=BOX_COLOR, width=stroke)
    if max(image.size) > max_side:
        image = _fit(image, max_side, max_side)
    elif max(image.size) < min_side:
        image = _fit(image, min_side, min_side)
    pad = 12
    width = max(image.width + 2 * pad, 560)
    header = _header(width, title, subtitle)
    legend_h = 34
    out = Image.new("RGB", (width, header.height + image.height + legend_h + pad), SHEET_BG)
    out.paste(header, (0, 0))
    out.paste(image, (pad, header.height))
    draw = ImageDraw.Draw(out)
    y = header.height + image.height + 8
    x = pad
    for v, text in ((20, "subtle"), (70, "medium"), (255, "strong")):
        draw.rectangle((x, y + 2, x + 18, y + 20), fill=(red[v], green[v], blue[v]))
        draw.text((x + 24, y + 1), text, fill=INK, font=font(16))
        x += 34 + round(_text_width(draw, text, 16)) + 12
    draw.rectangle((x, y + 2, x + 18, y + 20), outline=BOX_COLOR, width=3)
    draw.text((x + 24, y + 1), "changed region", fill=INK, font=font(16))
    return out
