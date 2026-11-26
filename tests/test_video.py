"""Video input: probing, marks, layout, planning, and real Chromium on the video fixtures."""

import json

from PIL import Image
from pydantic import ValidationError
import pytest

import framesheet
from framesheet import marks as marklib, media, video
from framesheet.models import ActivitySample, Marks
from tests.conftest import FIXTURES


MARKS = FIXTURES / "square.marks.json"


def _codes(result) -> set[str]:
    return {f.code for f in result.findings}


# Pure -----------------------------------------------------------------------------------


def test_probe_containers():
    webm = media.probe((FIXTURES / "square.webm").read_bytes())
    assert (webm.container, webm.codec, webm.width, webm.height) == ("webm", "vp9", 320, 180)
    assert (webm.fps, webm.frame_count, webm.duration) == (10.0, 60, 6.0)
    mp4 = media.probe((FIXTURES / "square_h264.mp4").read_bytes())
    assert (mp4.container, mp4.codec, mp4.fps, mp4.frame_count, mp4.duration) == (
        "mp4",
        "h264",
        10.0,
        60,
        6.0,
    )
    gif = media.probe((FIXTURES / "square_gif.gif").read_bytes())
    assert (gif.container, gif.width, gif.height, gif.mime) == ("gif", 160, 90, "image/gif")
    with pytest.raises(ValueError, match="Not a supported video"):
        media.probe(b"<svg/>")


def test_marks_cases():
    cases = json.loads((FIXTURES / "marks_cases.json").read_text())
    for case in cases["valid"]:
        Marks.model_validate(case)
    for case in cases["invalid"]:
        with pytest.raises(ValidationError):
            Marks.model_validate(case)


def test_marks_load_and_norm():
    m = marklib.load_marks(MARKS)
    assert m.spans[0].box == (0.5, 0.6, 0.45, 0.2)
    px = marklib.load_marks('{"frame": {"width": 200, "height": 100}, "points": '
                            '[{"t": 1, "x": 50, "y": 25}]}')  # fmt: skip
    assert px.norm(px.points[0].x, px.points[0].y) == (0.25, 0.25)


def test_points_land_on_the_nearest_tile_only():
    m = Marks.model_validate({"points": [{"t": 1.0, "x": 0.5, "y": 0.5, "label": "click"}]})
    times = [0.0, 0.8, 1.6]
    windows = marklib.tile_windows(times, 0.0, 1.6)
    assert [v for w in windows for v in w] == pytest.approx([0.0, 0.4, 0.4, 1.2, 1.2, 1.6])
    on = [marklib.point_active(m.points[0], w, i == 2) for i, w in enumerate(windows)]
    assert on == [False, True, False]
    dragged = Marks.model_validate({"points": [{"t": 1.0, "x": 0.5, "y": 0.5, "duration": 0.5}]})
    assert [marklib.point_active(dragged.points[0], w, i == 2) for i, w in enumerate(windows)] == [
        False,
        True,
        True,
    ]


def test_tile_overlay_geometry():
    m = Marks.model_validate({
        "points": [{"t": 1, "x": 0.5, "y": 0.5, "label": "click"}],
        "regions": [{"start": 0, "end": 2, "x": 0.25, "y": 0.25, "w": 0.5, "h": 0.5}],
    })  # fmt: skip
    # 300x150 tile of a 400x200 viewport whose video is letterboxed to x=100..300.
    ops = marklib.tile_ops(
        m, 1.0, (0.5, 1.5), False, size=(300, 150), viewport=(400, 200),
        content=(100.0, 0.0, 200.0, 200.0),
    )  # fmt: skip
    outlines = [op["box"] for op in ops if op["op"] == "outline" and op["width"] == 2]
    # Region: content x 100 + 0.25*200 = 150 css -> 112 px; y 0.25*200 = 50 css -> 37 px.
    assert outlines[0] == [112, 37, 186, 111]
    # Point ring centred on (0.5, 0.5) -> css (200, 100) -> px (150, 75).
    assert outlines[1] == [144, 69, 156, 81]
    texts = [op["text"] for op in ops if op["op"] == "text"]
    assert texts == ["region", "click @1.00s"]
    assert all(0 <= v < 300 for op in ops if "box" in op for v in op["box"][::2])


def test_timeline_lanes():
    m = marklib.load_marks(MARKS)
    height, ops = marklib.timeline_ops(
        800,
        0.0,
        6.0,
        [0.0, 3.0, 6.0],
        marks=m,
        activity=[(0.0, 0.0), (3.0, 0.25), (6.0, 0.0)],
        issues=[{"kind": "static", "start": 3.0, "end": 6.0}],
    )
    texts = [op["text"] for op in ops if op["op"] == "text"]
    for lane in ("motion", "issues", "spans", "regions", "points", "tiles"):
        assert lane in texts
    assert "#3" in texts
    assert "static 3.0s" in texts
    assert height > 150
    # Full-height motion bar for a 25% step, spanning x(0)..x(3)-1.
    bars = [op for op in ops if op["op"] == "rect" and op["fill"] == marklib.BAR]
    assert len(bars) == 1
    assert bars[0]["box"][0] == marklib.PAD + marklib.LABEL_COL


def test_plan_times():
    assert video.plan_times(6, frames=4) == (0.0, 6, [0.0, 2.0, 4.0, 6.0], "evenly spaced")
    assert video.plan_times(6.5, every=2)[2] == [0.0, 2.0, 4.0, 6.0, 6.5]
    assert video.plan_times(6, times=[3, 1, 1])[2] == [1.0, 3.0]
    m = marklib.load_marks(MARKS)
    assert video.plan_times(6, times="marks", marks=m)[2] == [1.0, 1.5, 1.6, 4.25]
    with pytest.raises(ValueError, match="Invalid range"):
        video.plan_times(6, start=5, end=4)
    with pytest.raises(ValueError, match="outside"):
        video.plan_times(6, times=[7])


def test_static_stretches_and_cuts():
    s = [ActivitySample(t=t, changed_ratio=r) for t, r in
         [(0, 0), (1, 0.01), (2, 0.0), (3, 0.0001), (4.5, 0.0), (5, 0.9), (6, 0.01)]]  # fmt: skip
    assert video.static_stretches(s, 2.0) == [(1, 4.5)]
    assert video.static_stretches(s, 4.0) == []
    assert video.abrupt_cuts(s) == [5]


def test_frame_stats_and_sharpness():
    black = Image.new("RGB", (40, 20), (5, 5, 5))
    white = Image.new("RGB", (40, 20), (255, 255, 255))
    assert video.frame_stats(black) == (True, False)
    assert video.frame_stats(white) == (False, True)
    assert video.sharpness(white) == 0
    edge = white.copy()
    edge.paste((0, 0, 0), (20, 0, 40, 20))
    assert video.frame_stats(edge) == (False, False)
    assert video.sharpness(edge) == pytest.approx(255 * 20 / 800)


# Real Chromium ---------------------------------------------------------------------------


def test_square_video_findings(inspected):
    result = inspected("square.webm", marks=MARKS)
    assert result.kind == "video"
    assert _codes(result) == {
        "video-static-stretch",
        "video-black-frames",
        "video-abrupt-cut",
        "video-mark-overlap",
    }
    v = result.video
    assert v is not None
    assert (v.container, v.codec, v.decoder, v.width, v.height) == (
        "webm",
        "vp9",
        "video",
        320,
        180,
    )
    assert (v.fps, v.frame_count, v.media_duration) == (10.0, 60, 6.0)
    stretch = next(f for f in result.findings if f.code == "video-static-stretch")
    assert stretch.times is not None
    assert stretch.times[0] == pytest.approx(2.0, abs=0.15)
    assert stretch.times[1] > 4.2
    black = next(f for f in result.findings if f.code == "video-black-frames")
    assert black.times
    assert all(4.5 <= t < 4.8 for t in black.times)
    assert [t.media_time for t in v.tiles][-1] == pytest.approx(5.9)
    assert any(t.duplicate for t in v.tiles)
    assert "click #save @1.00s" in v.tiles[2].marks
    assert result.loop.checked is False
    assert result.elements == []
    report = json.loads(result.images.report.read_text())
    assert report["marks"]["spans"][0]["kind"] == "caption"
    assert "video: webm vp9 320x180 10fps, 60 frames" in result.summary()


def test_gif_via_image_decoder(inspected):
    result = inspected("square_gif.gif", frames=6)
    v = result.video
    assert v is not None
    assert (v.decoder, v.frame_count, v.media_duration, v.fps) == ("image-decoder", 60, 6.0, 10.0)
    assert "video-black-frames" in _codes(result)


def test_range_and_every(inspected):
    result = inspected("square.webm", start=1.0, end=3.0, every=0.5, heat_frames=8)
    assert result.times == [1.0, 1.5, 2.0, 2.5, 3.0]
    assert result.video is not None
    assert [t.media_time for t in result.video.tiles] == [1.0, 1.5, 2.0, 2.5, 3.0]
    assert result.full_at == 1.0


def test_video_sheet_is_deterministic(tmp_path, inspected):
    first = inspected("square.webm", marks=MARKS)
    again = framesheet.inspect(FIXTURES / "square.webm", out=tmp_path, marks=MARKS)
    assert first.images.sheet.read_bytes() == again.images.sheet.read_bytes()
    assert first.images.heatmap.read_bytes() == again.images.heatmap.read_bytes()
    plain = inspected("square.webm", heat_frames=0)
    with Image.open(first.images.sheet) as a, Image.open(plain.images.sheet) as b:
        assert a.height > b.height  # marks band + more timeline lanes
        assert a.width == b.width


def test_h264_decodes_or_explains(tmp_path):
    try:
        result = framesheet.inspect(
            FIXTURES / "square_h264.mp4", out=tmp_path, frames=4, heat_frames=8
        )
    except ValueError as exc:
        assert "libvpx-vp9" in str(exc)  # noqa: PT017
    else:
        assert result.video is not None
        assert result.video.codec == "h264"


def test_video_only_options_are_rejected_for_svg(tmp_path):
    with pytest.raises(ValueError, match="only for video"):
        framesheet.inspect(FIXTURES / "pipeline.svg", out=tmp_path, every=1.0)
    with pytest.raises(ValidationError):
        framesheet.inspect(
            FIXTURES / "square.webm", out=tmp_path, marks={"spans": [{"start": 1, "end": 0}]}
        )
