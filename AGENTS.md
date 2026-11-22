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
tests/fixtures/ deliberately flawed SVG/HTML (one bug each) + pipeline.svg (clean);
                used by BOTH test suites (Python and js/)
docs/assets/    example images generated from the fixtures (used in README.md)
docs/contexter-skill.md  sketch: framesheet as an agent tool in contexter
schema/
  report.schema.json  JSON Schema of report.json, generated from models.py
                      (`report_schema()`; finding codes are an enum from FINDING_CODES)
  golden/*.json       Python reports for the fixtures (paths reduced to file names)
scripts/sync_schema.py  regenerates schema/ (`--golden` also the golden reports)
js/                 npm package `framesheet` (TypeScript port, see js/README.md)
  src/inspect.ts    pipeline (= core.py), inspect(), inspectPage(), prepare()
  src/driver.ts     time control on one page/frame (= render.py Session)
  src/timing.ts, analysis.ts, checks.ts, sources.ts, models.ts  (= the .py modules)
  src/compose.ts    sheet/heatmap layout (= compose.py), drawn on a canvas in Chromium
  src/pixels.ts     pngjs decode, diff stats, motion map, heat colours
  src/pyfmt.ts      Python round()/format semantics (reports and messages match)
  src/test.ts       `framesheet/test`: expectAnimation() for @playwright/test
  scripts/embed-assets.mjs  embeds ../src/framesheet/runtime.js + the font (build step)
  test/             vitest (reuses ../tests/fixtures), e2e/ Playwright demo + baselines
```

## Two implementations, one behaviour

- `src/framesheet/runtime.js` is the single source of truth for in-page logic. Never
  copy it into `js/`: `npm run build` embeds it (`js/src/generated/`, git-ignored) and
  `npm run check:runtime` + `js/test/runtime.test.ts` fail if dist/ differs. Changes must
  keep the Python behaviour (the Python suite runs against it; `scope()`/`resume()` are
  used only by the npm `inspectPage`).
- Everything else is ported 1:1 (same constants, thresholds, messages, rounding via
  `js/src/pyfmt.ts`). The report must validate against `schema/report.schema.json`;
  `js/test/parity.test.ts` compares each fixture with `schema/golden/` (tolerant for
  pixel numbers locally, strict in CI where the goldens are regenerated on the runner).
- Images: same layout and colours; Pillow's bundled Aileron font is embedded in the npm
  package (`js/assets/Aileron-Regular.ttf`, CC0), text is placed with FreeType's
  rounded-up ascender, so sheets look the same (pixels differ only in antialiasing).
- After changing models.py or finding codes: `uv run python scripts/sync_schema.py
  --golden` and commit `schema/`. `tests/test_schema.py` fails if the schema is stale or
  a code is emitted that is not in `FINDING_CODES`.

## Time control (per animation type)

A `Session` owns one page. Time only moves forward; `core.inspect` sorts all sample
times and visits them in order.

1. Before navigation: `page.clock.pause_at()` (installs the fake clock; no separate `install()`, whose real-time gap would leak into `performance.now()`). `Date`, `performance.now`,
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

Determinism (same input -> same PNG bytes) is tested in `test_deterministic_output`
(declarative) and `test_deterministic_js_driven_output` (rAF canvas: the fake clock's tick
origin must not drift). If you touch render.py/runtime.js, run them several times.

npm `inspectPage` on a page you navigated yourself: SMIL/CSS/WAAPI seeking works as
above; JS clocks only if `prepare(page)` installed the fake clock before `goto` (it then
pauses on a 16 ms tick boundary, steps, and resumes afterwards; `prepare(page, { paused:
true })` freezes time from navigation like the Python Session). `locator` calls the
runtime's `scope(el)`, which limits timings/elements/canvas to that subtree.

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

Add it to **both** implementations and register the code first:

- First add the code to `FINDING_CODES` in `models.py` (kebab-case, stable: it is API)
  and run `uv run python scripts/sync_schema.py --golden` (the schema enum allows it).
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
- npm port: static checks go into `js/src/checks.ts` (`checkSvgParsed` /
  `checkHtmlParsed` / `checkCss`; parsing is DOMParser in the browser, the logic runs in
  Node), render checks into `js/src/analysis.ts` (append to `CHECKS`, same `Geometry`
  fields in camelCase: `geo.client`, `geo.user`, `geo.elements`, `geo.targets` are
  `Map`s). Same message text. Add the fixture to `GOLDEN_FIXTURES` in
  `scripts/sync_schema.py`, regenerate the goldens, and assert the code in
  `js/test/inspect.test.ts`.

## Dev

```bash
uv sync --all-extras
uv run playwright install chromium     # once
uv run pytest                          # real Chromium, ~1.5 min
uv run ruff check . && uv run ruff format --check . && uv run ty check
```

npm package (Node >= 22 for the tooling; the library itself runs on Node >= 20 and Bun):

```bash
cd js
npm ci && npx playwright install chromium
npm run build && npm run typecheck && npm test   # vitest, ~2 min
npm run test:e2e                                 # Playwright demo of expectAnimation
npm run test:e2e -- --update-snapshots           # re-record e2e baselines
FRAMESHEET_GOLDEN_DIR=../schema/golden npm test  # strict parity (goldens from this machine)
```

CI: `.github/workflows/build.yml` (Python, template-managed) and
`.github/workflows/js.yml` (npm: build, type check, runtime parity, vitest with strict
parity against freshly generated Python reports, e2e, Node 20 + Bun smoke tests).

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
