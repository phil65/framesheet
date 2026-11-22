# AGENTS.md: framesheet

framesheet renders animated SVG/HTML at exact virtual times with Playwright (Chromium)
and writes `full.png`, `sheet.png`, `heatmap.png` and `report.json`. See README.md for
user-facing docs.

## Layout

```
src/framesheet/
  core.py       inspect(): the pipeline (resolve -> load -> detect duration -> sample
                -> static + render checks -> compose images -> report.json)
  sources.py    input resolution (file / URL / stdin / markup string), SVG size detection
  render.py     Session: Playwright browser + fake clock, seek(t), screenshot, snapshot
  runtime.js    in-page helper (window.__framesheet): timings, seek, geometry, settle
  timing.py     duration detection (SMIL/CSS/WAAPI timing -> cycle) and sample times
  checks.py     static source checks (ported from the svg-animation skill's verify_svg.py)
  analysis.py   render checks on per-frame geometry (Geometry + CHECKS registry)
  compose.py    Pillow: diff stats, contact sheet, motion heatmap
  models.py     pydantic result models (InspectionResult, Finding, ...) + summary()
  cli.py        typer CLI: `framesheet inspect`, `framesheet install-browser`
tests/fixtures/ deliberately flawed SVG/HTML (one bug each) + pipeline.svg (clean)
docs/assets/    example images generated from the fixtures (used in README.md)
```

## Time control (per animation type)

A `Session` owns one page. Time only moves forward; `core.inspect` sorts all sample
times and visits them in order.

1. Before navigation: `page.clock.install()` + `pause_at()`. `Date`, `performance.now`,
   timers and `requestAnimationFrame` are fake and frozen.
2. After `load`: evaluate `runtime.js`, wait for `document.fonts.ready` and images, run
   the fake clock for one frame (17 ms) so rAF content has painted, then `seek(0)`.
3. `seek(t)`:
   - JS: `page.clock.run_for(delta_ms)` fires due timers/rAF callbacks in order.
   - SMIL: `pauseAnimations()` + `setCurrentTime(t)` on each outermost `<svg>`.
   - CSS animations/transitions + Web Animations: `document.getAnimations()` -> `pause()`,
     `currentTime = (t - birth) * 1000`, where `birth` is the virtual time the animation
     was first seen (0 for everything present at load).
   - `settle()`: awaits two tiny Web Animations on the real document timeline, i.e. two
     real compositor frames (rAF is faked, so it cannot be used for this).
4. Chromium runs with `--disable-threaded-animation`: compositor-thread animations race
   with `pause()` and made the first frame nondeterministic. Keep it.

Determinism (same input -> same PNG bytes) is tested in `test_deterministic_output`.
If you touch render.py/runtime.js, run that test several times.

## Duration detection (timing.py)

- Infinite animations contribute their period (`duration`, x2 for `alternate`). Several
  periods -> LCM at 10 ms resolution if <= 4x the longest period and <= 60 s, else the
  longest. A positive start (begin/delay) is added once (warm-up visible on the sheet).
- Finite animations contribute `delay + duration x iterations (+ endDelay)`.
- `--duration` overrides; no declarative animation -> 3 s fallback (+ `js-driven-motion`
  warning if pixels change).
- Sample times: `i * D / (N - 1)`, last one moved to `D - 1/60 s`: at exactly `t = D`
  an infinite animation has wrapped to frame 0, which would hide a jump. The loop check
  compares `f(D - eps)` vs `f(0)` against one normal step `f(0)` vs `f(eps)`.

## Adding a check

- Static (source text): add to `checks.py` (`check_svg_source` / `check_html_source` /
  `check_css`), return `Finding(check="static", ...)` via `_finding`. Test in
  `tests/test_checks.py` (no browser needed).
- Render (geometry over time): write `def check_x(geo: Geometry) -> list[Finding]` in
  `analysis.py` and append it to `CHECKS`. `geo.client[i][k]` is the CSS-px client rect
  of element `i` at frame `k` (`None` = not rendered/invisible), `geo.user` the same in
  outermost-SVG user units, `geo.elements[i]` has tag/label/parent, `geo.targets` maps
  declared animation targets. If you need new per-element data, extend `measure()` /
  `describe()` in `runtime.js`.
- Add a minimal fixture with exactly one bug under `tests/fixtures/` and assert the code
  in `tests/test_inspect.py`. Finding codes are kebab-case and stable (they are API).

## Dev

```bash
uv sync --all-extras
uv run playwright install chromium     # once
uv run pytest                          # real Chromium, ~1.5 min
uv run ruff check . && uv run ruff format --check . && uv run ty check
```

Regenerate the README images after visual changes to compose.py:

```bash
for f in pipeline parked_dot; do
  uv run framesheet inspect tests/fixtures/$f.svg --out /tmp/fs-$f
  cp /tmp/fs-$f/sheet.png docs/assets/${f}_sheet.png
  cp /tmp/fs-$f/heatmap.png docs/assets/${f}_heatmap.png
done
```

Then look at them (also downscaled to ~800 px wide) before committing.

The repo is generated from copier-phil65: keep template files (workflows, duties.py,
pyproject sections) structurally intact; project-specific additions go below the
`# Only add below (Copier)` markers or in clearly commented extra steps.
