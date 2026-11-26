"""Duration detection and sampling (pure Python)."""

import pytest

from framesheet.models import AnimationTiming
from framesheet.sources import looks_like_svg, parse_size, svg_size
from framesheet.timing import FALLBACK_SECONDS, detect_duration, sample_times


def anim(duration, *, start=0.0, iterations=None, alternate=False, kind="css-animation"):
    period = duration * (2 if alternate else 1)
    end = None if iterations is None else start + duration * iterations
    return AnimationTiming(
        kind=kind,
        start=start,
        duration=duration,
        iterations=iterations,
        period=period,
        end=end,
        direction="alternate" if alternate else "normal",
    )


def test_fallback():
    info = detect_duration([])
    assert info.method == "fallback"
    assert info.seconds == FALLBACK_SECONDS


def test_override_wins():
    info = detect_duration([anim(2)], override=5)
    assert (info.method, info.seconds) == ("override", 5)


def test_lcm_of_periods():
    assert detect_duration([anim(2), anim(3)]).seconds == pytest.approx(6)


def test_incommensurate_periods_use_longest():
    info = detect_duration([anim(1.7), anim(2.3)])
    assert info.seconds == pytest.approx(2.3)
    assert "longest" in info.detail


def test_alternate_doubles_period():
    assert detect_duration([anim(1.5, alternate=True)]).seconds == pytest.approx(3)


def test_positive_start_adds_warmup_negative_does_not():
    assert detect_duration([anim(2, start=1)]).seconds == pytest.approx(3)
    assert detect_duration([anim(2, start=-0.5)]).seconds == pytest.approx(2)


def test_finite_end():
    info = detect_duration([anim(1.5, start=0.5, iterations=2)])
    assert info.seconds == pytest.approx(3.5)
    assert info.looping is False


def test_cap():
    assert detect_duration([anim(100, iterations=1)]).seconds == 60


def test_sample_times():
    times = sample_times(3.0, 4)
    assert times[:3] == [0.0, 1.0, 2.0]
    assert times[-1] == pytest.approx(3.0 - 1 / 60, abs=1e-4)


def test_sources_helpers():
    assert parse_size("640x360") == (640, 360)
    with pytest.raises(ValueError, match="WIDTHxHEIGHT"):
        parse_size("big")
    assert svg_size('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 460"/>') == (960, 460)
    assert svg_size(
        '<svg xmlns="http://www.w3.org/2000/svg" width="200" viewBox="0 0 100 50"/>'
    ) == (
        200,
        100,
    )
    assert looks_like_svg('<?xml version="1.0"?>\n<!-- c -->\n<svg/>')
    assert not looks_like_svg("<div>hi</div>")
