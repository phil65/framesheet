"""End-to-end tests: real Chromium, deliberately flawed fixtures."""

from __future__ import annotations

import json

from PIL import Image
import pytest

import framesheet
from framesheet import compose
from tests.conftest import FIXTURES


def _codes(result, check: str | None = None) -> set[str]:
    return {f.code for f in result.findings if check is None or f.check == check}


def test_parked_dot_before_positive_begin(inspected):
    result = inspected("parked_dot.svg")
    assert {"positive-begin", "parked-at-origin"} <= _codes(result)
    parked = next(f for f in result.findings if f.code == "parked-at-origin")
    assert parked.element == "circle#dot"
    assert parked.times is not None
    assert parked.times[0] == 0.0
    assert all(t < 1.0 for t in parked.times)  # moves onto its path once begin=1s fires
    # Duration = 1s warm-up + 2s loop period.
    assert result.duration.seconds == pytest.approx(3.0)
    assert result.duration.method == "detected"


def test_text_overflowing_its_card(inspected):
    result = inspected("text_overflow.svg")
    finding = next(f for f in result.findings if f.code == "text-overflow")
    assert finding.element is not None
    assert finding.element.startswith("text#label")
    assert "rect#card" in finding.message


def test_element_flying_outside_viewbox_mid_animation(inspected):
    result = inspected("fly_out.svg")
    finding = next(f for f in result.findings if f.code == "outside-bounds")
    assert finding.element == "rect#box"
    assert finding.times is not None
    assert 0.0 not in finding.times  # inside at the start ...
    assert any(0.8 <= t <= 1.2 for t in finding.times)  # ... outside mid-cycle
    assert result.loop.seamless is True


def test_non_seamless_loop(inspected):
    result = inspected("non_seamless.svg")
    assert "non-seamless-loop" in _codes(result)
    assert result.loop.checked
    assert result.loop.seamless is False
    assert result.loop.seam_ratio is not None
    assert result.loop.step_ratio is not None
    assert result.loop.seam_ratio > result.loop.step_ratio


def test_css_rotation_without_transform_box(inspected):
    result = inspected("rotate_no_box.svg")
    assert "transform-without-box" in _codes(result, "static")
    assert "svg-transform-box" in _codes(result, "render")
    # The square swings around (0,0) and leaves the canvas: visible in geometry too.
    assert "outside-bounds" in _codes(result)


def test_raf_canvas_animation_is_frame_accurate(inspected):
    result = inspected("raf_canvas.html")
    assert result.duration.method == "fallback"
    assert "js-driven-motion" in _codes(result)
    assert any(f.changed_ratio > 0 for f in result.frames[1:])


def test_raf_canvas_position_matches_virtual_time(tmp_path):
    result = framesheet.inspect(
        FIXTURES / "raf_canvas.html", frames=3, duration=2.0, at=1.0, out=tmp_path, heat_frames=0
    )
    full = Image.open(result.images.full).convert("RGB")
    # The dot is at x = 320 + 220*cos(pi*t): at t=1.0s it is leftmost, centred on x=100.
    green = [x for x in range(640) if full.getpixel((x, 180))[1] > 150]
    assert green
    centre = (green[0] + green[-1]) / 2
    assert centre == pytest.approx(100, abs=4)


def test_clean_fixture_has_no_warnings(inspected):
    result = inspected("pipeline.svg")
    assert [f for f in result.findings if f.severity != "info"] == []
    assert result.duration.seconds == pytest.approx(4.0)  # LCM of 2s and 4s
    assert result.loop.seamless is True
    elements = {e.element for e in result.elements}
    assert "rect.pl-spin[4]" in elements


def test_web_animation_alternate_period(inspected):
    result = inspected("waapi.html")
    kinds = {a.kind for a in result.duration.animations}
    assert kinds == {"web-animation"}
    assert result.duration.seconds == pytest.approx(3.0)  # alternate: 2 x 1.5s
    assert result.loop.seamless is True


def test_finite_animation(inspected):
    result = inspected("finite.svg")
    assert result.duration.looping is False
    assert result.duration.seconds == pytest.approx(2.0)  # begin 0.5s + dur 1.5s
    assert result.loop.checked is False
    track = next(e for e in result.elements if e.element == "rect#bar")
    first, last = track.boxes[0], track.boxes[-1]
    assert first is None or first[2] < 1
    assert last is not None
    assert last[2] > 250


def test_html_text_overflow(inspected):
    result = inspected("html_overflow.html")
    finding = next(f for f in result.findings if f.code == "text-overflow")
    assert finding.element is not None
    assert finding.element.startswith("div.badge")


def test_sheet_geometry(inspected):
    result = inspected("fly_out.svg")
    sheet = Image.open(result.images.sheet)
    frames = len(result.times)
    assert frames == 12
    aspect = 400 / 200
    cols = compose.default_columns(frames, aspect)
    rows = -(-frames // cols)
    tile = compose.auto_tile(cols)
    pad, gap, label = compose.PAD, compose.GAP, compose.LABEL_H
    assert sheet.width == 2 * pad + cols * (tile + 2) + (cols - 1) * gap
    tile_h = round(tile / aspect)
    assert sheet.height == (
        compose.HEADER_H + 2 * pad + rows * (tile_h + 2 + label) + (rows - 1) * gap
    )
    assert sheet.width <= compose.MAX_SHEET_WIDTH
    # Last tile is one 60 fps frame before the cycle end.
    assert result.times[-1] == pytest.approx(2.0 - 1 / 60, abs=1e-3)


def test_custom_frames_and_columns(tmp_path):
    result = framesheet.inspect(
        FIXTURES / "fly_out.svg", frames=4, columns=4, tile=100, out=tmp_path, heat_frames=0
    )
    sheet = Image.open(result.images.sheet)
    assert len(result.times) == 4
    assert sheet.width == max(2 * compose.PAD + 4 * 102 + 3 * compose.GAP, 560)
    assert sheet.height == compose.HEADER_H + 2 * compose.PAD + 50 + 2 + compose.LABEL_H


def test_report_json_and_paths(inspected):
    result = inspected("parked_dot.svg")
    for path in (result.images.full, result.images.sheet, result.images.heatmap):
        assert path.is_file()
    data = json.loads(result.images.report.read_text())
    assert data["duration"]["seconds"] == pytest.approx(3.0)
    assert len(data["frames"]) == len(result.times)
    full = Image.open(result.images.full)
    assert full.size == (400, 200)


def test_deterministic_output(tmp_path):
    a = framesheet.inspect(FIXTURES / "pipeline.svg", out=tmp_path / "a")
    b = framesheet.inspect(FIXTURES / "pipeline.svg", out=tmp_path / "b")
    for name in ("full", "sheet", "heatmap"):
        assert getattr(a.images, name).read_bytes() == getattr(b.images, name).read_bytes(), name


def test_deterministic_js_driven_output(tmp_path):
    """rAF/canvas frames depend on the fake clock's tick origin: it must not drift."""
    runs = [
        framesheet.inspect(
            FIXTURES / "raf_canvas.html", frames=4, heat_frames=0, out=tmp_path / name
        )
        for name in ("a", "b")
    ]
    a, b = (r.images.sheet.read_bytes() for r in runs)
    assert a == b
    assert [f.changed_ratio for f in runs[0].frames] == [f.changed_ratio for f in runs[1].frames]


def test_snippet_and_size(tmp_path):
    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><title>x</title>'
        '<rect width="100" height="50" fill="red"/></svg>'
    )
    result = framesheet.inspect(svg, out=tmp_path, size=(200, 100), frames=2, heat_frames=0)
    assert result.kind == "svg"
    assert result.viewport == (200, 100)
    assert "no-motion" in _codes(result)
    assert Image.open(result.images.full).size == (200, 100)


def test_small_svg_is_auto_scaled(tmp_path):
    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><title>i</title>'
        '<circle cx="12" cy="12" r="8"/></svg>'
    )
    result = framesheet.inspect(svg, out=tmp_path, frames=2, heat_frames=0)
    assert result.device_scale_factor > 1
    full = Image.open(result.images.full)
    assert full.width == round(24 * result.device_scale_factor)
