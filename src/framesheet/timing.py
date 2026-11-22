"""Duration detection and sample-time planning."""

from __future__ import annotations

from functools import reduce
import math
from typing import Any

from framesheet.models import AnimationTiming, DurationInfo


FALLBACK_SECONDS = 3.0
MAX_SECONDS = 60.0
LCM_FACTOR = 4
"""Use the LCM of loop periods only if it is at most this many times the longest period."""
EPSILON = 1 / 60
"""One 60 fps frame: the last tile and the loop probe sit this far before the cycle end."""


def parse_timings(raw: list[dict[str, Any]]) -> list[AnimationTiming]:
    return [AnimationTiming.model_validate(item) for item in raw]


def _lcm(periods: list[float]) -> float:
    ticks = [max(1, round(p * 100)) for p in periods]  # 10 ms resolution
    return reduce(math.lcm, ticks) / 100


def detect_duration(
    animations: list[AnimationTiming], override: float | None = None
) -> DurationInfo:
    """Pick the time span to sample.

    * Infinite animations contribute their loop period (``duration``, doubled for
      ``alternate``). Several periods are combined with their least common multiple if
      that stays reasonable, otherwise the longest period wins.
    * A positive start (``begin``/``delay``) of a looping animation is added, so the
      warm-up before the first iteration is visible.
    * Finite animations contribute their end time (delay + duration x iterations).
    """
    infinite = [a for a in animations if a.iterations is None]
    finite = [a for a in animations if a.iterations is not None and a.end is not None]
    looping = bool(infinite)
    if override is not None:
        return DurationInfo(
            seconds=override,
            method="override",
            looping=looping,
            detail=f"--duration {override:g}s",
            animations=animations,
        )
    if not animations:
        return DurationInfo(
            seconds=FALLBACK_SECONDS,
            method="fallback",
            looping=False,
            detail=f"no SMIL/CSS/Web Animations found; sampled the {FALLBACK_SECONDS:g}s "
            "fallback (pass --duration for JS-driven animation)",
        )
    parts: list[str] = []
    seconds = 0.0
    if infinite:
        periods = sorted({round(a.period, 3) for a in infinite})
        cycle = _lcm(periods)
        if len(periods) == 1:
            parts.append(f"loop period {periods[0]:g}s")
        elif cycle <= LCM_FACTOR * periods[-1] and cycle <= MAX_SECONDS:
            parts.append(f"LCM of loop periods {', '.join(f'{p:g}s' for p in periods)}")
        else:
            cycle = periods[-1]
            parts.append(
                f"longest of loop periods {', '.join(f'{p:g}s' for p in periods)} "
                "(no short common multiple)"
            )
        seconds = cycle
        warmup = max(max(a.start for a in infinite), 0.0)
        if warmup > 0:
            seconds = max(seconds, warmup + cycle)
            parts.append(f"+ {warmup:g}s positive begin/delay before the first loop")
    if finite:
        last_end = max(a.end or 0.0 for a in finite)
        if last_end > seconds:
            seconds = last_end
            parts.append(f"finite animations end at {last_end:g}s")
    kinds = sorted({a.kind for a in animations})
    detail = f"{'; '.join(parts)} ({len(animations)} animation(s): {', '.join(kinds)})"
    if seconds > MAX_SECONDS:
        detail += f"; capped at {MAX_SECONDS:g}s"
        seconds = MAX_SECONDS
    if seconds <= 0:
        seconds = FALLBACK_SECONDS
        detail += f"; zero-length, using {FALLBACK_SECONDS:g}s"
    return DurationInfo(
        seconds=round(seconds, 3),
        method="detected",
        looping=looping,
        detail=detail,
        animations=animations,
    )


def sample_times(duration: float, frames: int) -> list[float]:
    """Evenly spaced times over ``[0, duration]``.

    The last sample is taken one 60 fps frame *before* the end: at exactly ``t=end`` an
    infinite animation has already wrapped to its first frame, which would make every
    loop look seamless.
    """
    if frames < 2:  # noqa: PLR2004
        return [0.0]
    times = [round(duration * i / (frames - 1), 4) for i in range(frames)]
    times[-1] = round(duration - epsilon(duration), 4)
    return times


def epsilon(duration: float) -> float:
    """The probe offset for loop checks: one 60 fps frame, or 1% of very short cycles."""
    return min(EPSILON, duration / 100)
