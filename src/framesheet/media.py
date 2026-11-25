"""Container probing for video inputs (no ffmpeg): format, codec, size, frame rate.

Reads just enough of ISO BMFF (mp4/mov), Matroska/WebM and GIF/WebP headers. Everything
is best effort: unknown fields are ``None`` and the browser's values win where both exist.
Ported 1:1 in ``js/src/media.ts``.
"""

from __future__ import annotations

from dataclasses import dataclass
import struct


VIDEO_EXTENSIONS = {
    ".mp4": "mp4",
    ".m4v": "mp4",
    ".mov": "mov",
    ".webm": "webm",
    ".mkv": "mkv",
    ".gif": "gif",
    ".webp": "webp",
}
MIME_TYPES = {
    "mp4": "video/mp4",
    "mov": "video/mp4",
    "webm": "video/webm",
    "mkv": "video/webm",
    "gif": "image/gif",
    "webp": "image/webp",
}
_MP4_CODECS = {
    "avc1": "h264",
    "avc3": "h264",
    "hvc1": "hevc",
    "hev1": "hevc",
    "av01": "av1",
    "vp09": "vp9",
    "vp08": "vp8",
    "mp4v": "mpeg4",
}
_MKV_CODECS = {
    "V_VP8": "vp8",
    "V_VP9": "vp9",
    "V_AV1": "av1",
    "V_MPEG4/ISO/AVC": "h264",
    "V_MPEGH/ISO/HEVC": "hevc",
}


@dataclass
class Probe:
    """What the container says about the (first) video track."""

    container: str
    codec: str | None = None
    width: int | None = None
    height: int | None = None
    fps: float | None = None
    frame_count: int | None = None
    duration: float | None = None

    @property
    def mime(self) -> str:
        return MIME_TYPES[self.container]

    @property
    def animated_image(self) -> bool:
        return self.container in {"gif", "webp"}


def sniff(data: bytes) -> str | None:
    """Container from magic bytes (``None`` if not a supported video/animated image)."""
    if data[4:8] == b"ftyp":
        return "mov" if data[8:12] == b"qt  " else "mp4"
    if data[:4] == b"\x1a\x45\xdf\xa3":
        return "webm" if b"webm" in data[:64] else "mkv"
    if data[:6] in {b"GIF87a", b"GIF89a"}:
        return "gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    return None


def probe(data: bytes, container: str | None = None) -> Probe:
    """Parse the container header (``container`` defaults to :func:`sniff`)."""
    kind = sniff(data) or container
    if kind is None:
        msg = "Not a supported video or animated image (mp4, mov, webm, mkv, gif, webp)"
        raise ValueError(msg)
    result = Probe(container=kind)
    try:
        if kind in {"mp4", "mov"}:
            _mp4(data, result)
        elif kind in {"webm", "mkv"}:
            _matroska(data, result)
        elif kind == "gif":
            result.codec = "gif"
            result.width, result.height = struct.unpack_from("<HH", data, 6)
        elif kind == "webp":
            result.codec = "webp"
            _webp(data, result)
    except struct.error, IndexError, ValueError, UnicodeDecodeError:
        pass
    if result.fps is not None:
        result.fps = round(result.fps, 3)
    if result.duration is not None:
        result.duration = round(result.duration, 4)
    return result


# ISO BMFF -------------------------------------------------------------------------------

_MP4_CONTAINERS = {b"moov", b"trak", b"mdia", b"minf", b"stbl"}


def _boxes(data: bytes, start: int, end: int):
    pos = start
    while pos + 8 <= end:
        size, kind = struct.unpack_from(">I4s", data, pos)
        header = 8
        if size == 1:
            size = struct.unpack_from(">Q", data, pos + 8)[0]
            header = 16
        elif size == 0:
            size = end - pos
        if size < header:
            return
        yield kind, pos + header, min(pos + size, end)
        pos += size


def _mp4(data: bytes, out: Probe) -> None:
    for kind, start, end in _boxes(data, 0, len(data)):
        if kind == b"moov":
            for tkind, tstart, tend in _boxes(data, start, end):
                if tkind == b"trak" and _mp4_track(data, tstart, tend, out):
                    return


def _mp4_track(data: bytes, start: int, end: int, out: Probe) -> bool:
    found: dict[bytes, tuple[int, int]] = {}

    def walk(s: int, e: int) -> None:
        for kind, cs, ce in _boxes(data, s, e):
            if kind in _MP4_CONTAINERS:
                walk(cs, ce)
            elif kind not in found:
                found[kind] = (cs, ce)

    walk(start, end)
    hdlr = found.get(b"hdlr")
    if not hdlr or data[hdlr[0] + 8 : hdlr[0] + 12] != b"vide":
        return False
    timescale = 0
    if mdhd := found.get(b"mdhd"):
        s = mdhd[0]
        if data[s] == 1:
            timescale, duration = struct.unpack_from(">IQ", data, s + 20)
        else:
            timescale, duration = struct.unpack_from(">II", data, s + 12)
        if timescale:
            out.duration = duration / timescale
    if stsd := found.get(b"stsd"):
        entry = stsd[0] + 8
        fourcc = data[entry + 4 : entry + 8].decode("latin-1")
        out.codec = _MP4_CODECS.get(fourcc, fourcc.strip() or None)
        out.width, out.height = struct.unpack_from(">HH", data, entry + 32)
    if (stts := found.get(b"stts")) and timescale:
        count = struct.unpack_from(">I", data, stts[0] + 4)[0]
        frames = total = 0
        for i in range(count):
            n, delta = struct.unpack_from(">II", data, stts[0] + 8 + 8 * i)
            frames += n
            total += n * delta
        if frames:
            out.frame_count = frames
        if total:
            out.fps = frames * timescale / total
    return True


# Matroska / WebM ------------------------------------------------------------------------

_MKV_ENTER = {
    0x18538067,  # Segment
    0x1549A966,  # Info
    0x1654AE6B,  # Tracks
    0xE0,  # Video
    0x1F43B675,  # Cluster
    0xA0,  # BlockGroup
}
_TRACK_ENTRY = 0xAE
_TIMECODE_SCALE = 0x2AD7B1
_DURATION = 0x4489
_CODEC_ID = 0x86
_TRACK_UINTS = {
    0xD7: "number",
    0x83: "type",
    0x23E383: "default_duration",  # ns per frame
    0xB0: "width",  # PixelWidth
    0xBA: "height",  # PixelHeight
}
_BLOCKS = {0xA3, 0xA1}  # SimpleBlock, Block


def _vint(data: bytes, pos: int, *, strip: bool) -> tuple[int, int, bool]:
    """EBML variable-length integer -> (value, length, all-ones = unknown size)."""
    first = data[pos]
    length = 1
    mask = 0x80
    while length <= 8 and not first & mask:  # noqa: PLR2004
        mask >>= 1
        length += 1
    if length > 8:  # noqa: PLR2004
        msg = "bad EBML vint"
        raise ValueError(msg)
    value = first & (mask - 1) if strip else first
    for i in range(1, length):
        value = (value << 8) | data[pos + i]
    unknown = strip and value == (1 << (7 * length)) - 1
    return value, length, unknown


def _uint(data: bytes, s: int, e: int) -> int:
    return int.from_bytes(data[s:e], "big")


def _matroska(data: bytes, out: Probe) -> None:
    tracks: list[dict[str, object]] = []
    blocks: dict[int, int] = {}
    timescale = 1_000_000
    duration: float | None = None
    pos = 4 + _vint(data, 4, strip=True)[1]
    pos += _vint(data, 4, strip=True)[0]  # skip the EBML header
    end = len(data)
    while pos < end:
        eid, ilen, _ = _vint(data, pos, strip=False)
        size, slen, unknown = _vint(data, pos + ilen, strip=True)
        body = pos + ilen + slen
        if eid in _MKV_ENTER:
            pos = body
            continue
        if eid == _TRACK_ENTRY:
            tracks.append({})
            pos = body
            continue
        if unknown:
            break
        stop = min(body + size, end)
        track = tracks[-1] if tracks else {}
        if eid == _TIMECODE_SCALE:
            timescale = _uint(data, body, stop)
        elif eid == _DURATION:  # float, in TimecodeScale units
            duration = struct.unpack(">f" if size == 4 else ">d", data[body:stop])[0]  # noqa: PLR2004
        elif eid == _CODEC_ID:
            track["codec"] = data[body:stop].rstrip(b"\0").decode("ascii")
        elif eid in _TRACK_UINTS:
            track[_TRACK_UINTS[eid]] = _uint(data, body, stop)
        elif eid in _BLOCKS:  # the track number comes first
            number = _vint(data, body, strip=True)[0]
            blocks[number] = blocks.get(number, 0) + 1
        pos = stop
    if duration is not None:
        out.duration = duration * timescale / 1e9
    video = next((t for t in tracks if t.get("type") == 1), None)
    if video is None:
        return
    codec = str(video.get("codec", ""))
    out.codec = _MKV_CODECS.get(codec, codec.removeprefix("V_").lower() or None)
    width, height = video.get("width"), video.get("height")
    out.width = width if isinstance(width, int) else None
    out.height = height if isinstance(height, int) else None
    number = video.get("number")
    count = blocks.get(number) if isinstance(number, int) else None
    out.frame_count = count or None
    default = video.get("default_duration")
    if isinstance(default, int) and default > 0:
        out.fps = 1e9 / default
    elif count and out.duration:
        out.fps = count / out.duration


# WebP -----------------------------------------------------------------------------------


def _webp(data: bytes, out: Probe) -> None:
    pos = 12
    frames = 0
    total_ms = 0
    while pos + 8 <= len(data):
        kind = data[pos : pos + 4]
        size = struct.unpack_from("<I", data, pos + 4)[0]
        body = pos + 8
        if kind == b"VP8X":
            out.width = 1 + int.from_bytes(data[body + 4 : body + 7], "little")
            out.height = 1 + int.from_bytes(data[body + 7 : body + 10], "little")
        elif kind == b"ANMF":
            frames += 1
            total_ms += int.from_bytes(data[body + 12 : body + 15], "little")
        elif kind == b"VP8 " and out.width is None:
            w, h = struct.unpack_from("<HH", data, body + 6)
            out.width, out.height = w & 0x3FFF, h & 0x3FFF
        elif kind == b"VP8L" and out.width is None:
            bits = int.from_bytes(data[body + 1 : body + 5], "little")
            out.width, out.height = (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
        pos = body + size + (size & 1)
    out.frame_count = frames or 1
    if total_ms:
        out.duration = total_ms / 1000
