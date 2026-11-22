"""Input handling: files, stdin snippets and URLs."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import re
import sys
from typing import TYPE_CHECKING
import urllib.request
import xml.etree.ElementTree as ET


if TYPE_CHECKING:
    from framesheet.models import SourceKind


DEFAULT_HTML_SIZE = (1280, 720)
DEFAULT_SVG_SIZE = (960, 540)
_LENGTH = re.compile(r"^\s*([0-9]*\.?[0-9]+)\s*(px)?\s*$")


@dataclass
class Source:
    """A resolved input."""

    label: str
    """What the user passed (path, ``-`` or URL)."""
    kind: SourceKind
    url: str
    """What the browser navigates to."""
    text: str | None
    """Source text if available locally (used for static checks and size detection)."""


def looks_like_svg(text: str) -> bool:
    head = re.sub(r"<!--.*?-->", "", text[:4096], flags=re.S).lstrip().lower()
    if head.startswith("<?xml"):
        head = head.split("?>", 1)[-1].lstrip()
    if head.startswith("<!doctype svg"):
        return True
    return head.startswith("<svg")


def resolve(source: str | Path, workdir: Path) -> Source:
    """Turn a path, ``-`` (stdin) or URL into a :class:`Source`.

    Stdin snippets are written to ``workdir`` so they load as real documents.
    """
    if isinstance(source, str) and source == "-":
        text = sys.stdin.read()
        return snippet(text, workdir, label="-")
    if isinstance(source, str) and re.match(r"^https?://", source):
        text = fetch_text(source)
        by_name = source.split("?")[0].lower().endswith(".svg")
        is_svg = by_name or bool(text and looks_like_svg(text))
        kind: SourceKind = "svg" if is_svg else "html"
        return Source(label=source, kind=kind, url=source, text=text)
    path = Path(source).expanduser().resolve()
    if not path.is_file():
        msg = f"Input not found: {source}"
        raise FileNotFoundError(msg)
    text = path.read_text(encoding="utf-8", errors="replace")
    if path.suffix.lower() == ".svg":
        kind = "svg"
    elif path.suffix.lower() in {".html", ".htm", ".xhtml"}:
        kind = "html"
    else:
        kind = "svg" if looks_like_svg(text) else "html"
    return Source(label=str(source), kind=kind, url=path.as_uri(), text=text)


def fetch_text(url: str, timeout: float = 15.0) -> str | None:
    """Best-effort download of a URL's body (for static checks and SVG size detection)."""
    request = urllib.request.Request(url, headers={"User-Agent": "framesheet"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.read().decode("utf-8", errors="replace")
    except (OSError, ValueError):
        return None


def snippet(text: str, workdir: Path, *, label: str = "<snippet>") -> Source:
    """Wrap an in-memory SVG/HTML snippet as a source (written to ``workdir``)."""
    kind: SourceKind = "svg" if looks_like_svg(text) else "html"
    if kind == "html" and "<html" not in text.lower():
        text = (
            f"<!DOCTYPE html>\n<html><head><meta charset='utf-8'></head><body>{text}</body></html>"
        )
    workdir.mkdir(parents=True, exist_ok=True)
    path = workdir / f"input.{kind}"
    path.write_text(text, encoding="utf-8")
    return Source(label=label, kind=kind, url=path.as_uri(), text=text)


def _length(value: str | None) -> float | None:
    if value is None:
        return None
    match = _LENGTH.match(value)
    return float(match.group(1)) if match else None


def svg_size(text: str) -> tuple[int, int] | None:
    """Intrinsic size of an SVG: absolute width/height attributes, else the viewBox."""
    try:
        root = ET.fromstring(text)
    except ET.ParseError:
        return None
    width, height = _length(root.get("width")), _length(root.get("height"))
    box = [float(v) for v in re.split(r"[\s,]+", root.get("viewBox", "").strip()) if v]
    if len(box) == 4 and box[2] > 0 and box[3] > 0:  # noqa: PLR2004
        vb_w, vb_h = box[2], box[3]
        if width and not height:
            height = width * vb_h / vb_w
        elif height and not width:
            width = height * vb_w / vb_h
        width, height = width or vb_w, height or vb_h
    if width and height:
        return max(1, round(width)), max(1, round(height))
    return None


def default_size(src: Source) -> tuple[int, int]:
    if src.kind == "svg" and src.text and (size := svg_size(src.text)):
        return size
    return DEFAULT_SVG_SIZE if src.kind == "svg" else DEFAULT_HTML_SIZE


def parse_size(value: str) -> tuple[int, int]:
    """Parse ``WxH`` (e.g. ``1280x720``)."""
    match = re.fullmatch(r"\s*(\d+)\s*[xX*]\s*(\d+)\s*", value)
    if not match:
        msg = f"Invalid size {value!r}; expected WIDTHxHEIGHT, e.g. 1280x720"
        raise ValueError(msg)
    return int(match.group(1)), int(match.group(2))
