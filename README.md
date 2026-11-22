# framesheet

[![PyPI License](https://img.shields.io/pypi/l/framesheet.svg)](https://pypi.org/project/framesheet/)
[![Package status](https://img.shields.io/pypi/status/framesheet.svg)](https://pypi.org/project/framesheet/)
[![Monthly downloads](https://img.shields.io/pypi/dm/framesheet.svg)](https://pypi.org/project/framesheet/)
[![Distribution format](https://img.shields.io/pypi/format/framesheet.svg)](https://pypi.org/project/framesheet/)
[![Wheel availability](https://img.shields.io/pypi/wheel/framesheet.svg)](https://pypi.org/project/framesheet/)
[![Python version](https://img.shields.io/pypi/pyversions/framesheet.svg)](https://pypi.org/project/framesheet/)
[![Implementation](https://img.shields.io/pypi/implementation/framesheet.svg)](https://pypi.org/project/framesheet/)
[![Releases](https://img.shields.io/github/downloads/phil65/framesheet/total.svg)](https://github.com/phil65/framesheet/releases)
[![Github Contributors](https://img.shields.io/github/contributors/phil65/framesheet)](https://github.com/phil65/framesheet/graphs/contributors)
[![Github Forks](https://img.shields.io/github/forks/phil65/framesheet)](https://github.com/phil65/framesheet/forks)
[![Github Issues](https://img.shields.io/github/issues/phil65/framesheet)](https://github.com/phil65/framesheet/issues)
[![Github Issues](https://img.shields.io/github/issues-pr/phil65/framesheet)](https://github.com/phil65/framesheet/pulls)
[![Github Watchers](https://img.shields.io/github/watchers/phil65/framesheet)](https://github.com/phil65/framesheet/watchers)
[![Github Stars](https://img.shields.io/github/stars/phil65/framesheet)](https://github.com/phil65/framesheet/stars)
[![Github Repository size](https://img.shields.io/github/repo-size/phil65/framesheet)](https://github.com/phil65/framesheet)
[![Github last commit](https://img.shields.io/github/last-commit/phil65/framesheet)](https://github.com/phil65/framesheet/commits)
[![Github release date](https://img.shields.io/github/release-date/phil65/framesheet)](https://github.com/phil65/framesheet/releases)
[![Github language count](https://img.shields.io/github/languages/count/phil65/framesheet)](https://github.com/phil65/framesheet)
[![Github commits this month](https://img.shields.io/github/commit-activity/m/phil65/framesheet)](https://github.com/phil65/framesheet)
[![Package status](https://codecov.io/gh/phil65/framesheet/branch/main/graph/badge.svg)](https://codecov.io/gh/phil65/framesheet/)
[![PyUp](https://pyup.io/repos/github/phil65/framesheet/shield.svg)](https://pyup.io/repos/github/phil65/framesheet/)

[Read the documentation!](https://phil65.github.io/framesheet/)

**framesheet** renders an animated SVG or HTML page at exact, evenly spaced points in
virtual time and turns them into images you (or an AI agent) can check at a glance.

An agent can only look at still images, and one screenshot shows one moment. A dot that
sits at `(0,0)` for the first second, a label that overflows its card, a box that flies
off the canvas halfway through, a loop that jumps back at the end: none of these show up
reliably in a single screenshot. framesheet captures the whole cycle, frame-accurately
and deterministically (same input, same PNG bytes), and adds numbers to back it up.

## What you get

For every input, in the output directory:

| File | Use it for |
| --- | --- |
| `full.png` | One full-resolution frame (default `t=0`, `--at SECONDS`): layout, text, margins. |
| `sheet.png` | Contact sheet: N frames (default 12) over one cycle, each labelled `t=0.50s`. The last tile is one 60 fps frame before the cycle end, so you can judge the loop against the first tile. |
| `heatmap.png` | Motion heatmap: every pixel that changes at any time, coloured over a dimmed first frame. Shows what moves at all, including things that should not. |
| `report.json` | Detected duration and how it was found, static findings, per-frame changed-pixel ratios, bounding boxes of animated elements, elements outside the viewBox or at `(0,0)`, loop seamlessness. |

A short summary is printed to stdout (`--json` prints the report instead).

Contact sheet of [`tests/fixtures/pipeline.svg`](tests/fixtures/pipeline.svg) (SMIL dots,
a pulsing CSS hub and a spinning badge; detected cycle: LCM of 2s and 4s):

![Contact sheet: 12 frames of the pipeline fixture](https://raw.githubusercontent.com/phil65/framesheet/main/docs/assets/pipeline_sheet.png)

Its motion heatmap:

![Motion heatmap of the pipeline fixture](https://raw.githubusercontent.com/phil65/framesheet/main/docs/assets/pipeline_heatmap.png)

And a buggy one, [`tests/fixtures/parked_dot.svg`](tests/fixtures/parked_dot.svg):
`<animateMotion begin="1s">` leaves the dot parked in the top-left corner for a second.
Tiles 1-4 show it, the heatmap marks the corner, and the report says
`parked-at-origin: circle#dot sits at the SVG origin (0,0) at t=0.00s, 0.27s, 0.55s, 0.82s`.

![Contact sheet of the parked-dot fixture](https://raw.githubusercontent.com/phil65/framesheet/main/docs/assets/parked_dot_sheet.png)

![Motion heatmap of the parked-dot fixture](https://raw.githubusercontent.com/phil65/framesheet/main/docs/assets/parked_dot_heatmap.png)

## Install

```bash
uv tool install framesheet        # or: pip install framesheet
framesheet install-browser        # downloads Playwright's Chromium (once)
```

`framesheet install-browser` runs `python -m playwright install chromium` in framesheet's
own environment, so the browser matches the installed Playwright version. In a project
environment, `uv run playwright install chromium` does the same. On a bare Linux CI
runner add `--with-deps` (`uv run playwright install --with-deps chromium`).

## CLI

```bash
framesheet inspect banner.svg                    # writes to a new temp dir, prints it
framesheet inspect banner.svg --out /tmp/check   # choose the output dir
framesheet inspect banner.svg -n 16 --at 1.25    # 16 tiles, full.png at t=1.25s
framesheet inspect page.html --size 1440x900 --scale 2
framesheet inspect canvas.html --duration 4      # JS-driven: give the cycle length
framesheet inspect a.svg b.svg --out /tmp/all    # one subdirectory per input
cat snippet.svg | framesheet inspect -           # SVG or HTML snippet on stdin
framesheet inspect https://example.com/anim.html
framesheet inspect banner.svg --json | jq .loop
```

Options: `--frames/-n`, `--duration`, `--at`, `--size WxH`, `--scale`, `--out/-o`,
`--tile`, `--columns`, `--keep-frames` (also write every frame to `frames/`), `--dark`
(`prefers-color-scheme: dark`), `--json`. The exit code is 1 if an error-level finding
was reported (for example malformed XML or a broken `#id` reference), 2 for usage
problems or a missing browser, 0 otherwise.

Example summary:

```text
framesheet: tests/fixtures/non_seamless.svg (svg, 400x200 @1x)
duration: 3s detected: loop period 3s (1 animation(s): css-animation) [looping]
frames: 12 at t=0.00..2.98s; max change 2.8% at t=2.45s
loop: NOT seamless (last frame -> first frame changes 4.73% of pixels, one normal step changes 0.40%)
animated elements: circle#runner
findings: 0 error(s), 1 warning(s), 0 info
  WARN  [render] non-seamless-loop: The loop jumps at the cycle end: ...
images:
  full     /tmp/framesheet-x1y2/full.png  (t=0s: layout, text, margins)
  sheet    /tmp/framesheet-x1y2/sheet.png  (motion over one cycle)
  heatmap  /tmp/framesheet-x1y2/heatmap.png  (what moves at all)
  report   /tmp/framesheet-x1y2/report.json
```

## Python API

```python
import framesheet

result = framesheet.inspect("banner.svg", frames=12, out="/tmp/check")
print(result.summary())
print(result.duration.seconds, result.duration.detail)
print(result.loop.seamless, result.images.sheet)
for finding in result.findings:
    print(finding.severity, finding.code, finding.element, finding.times)

# Markup strings work too (anything starting with "<").
framesheet.inspect('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">...</svg>')
```

`inspect()` returns an `InspectionResult` (pydantic model): image paths, `duration`,
`times`, `frames` (per-frame metrics), `elements` (per-frame boxes of animated elements),
`loop`, `findings` and `console_errors`. It uses Playwright's sync API, so call it
outside a running asyncio loop (or in a worker thread).

## JavaScript / TypeScript (npm)

The npm package [`framesheet`](js/README.md) (in [`js/`](js/)) is a TypeScript port with
the same in-page runtime, report schema and image layout, for Node/Bun servers and
Playwright e2e suites:

```ts
import { inspect, inspectPage } from "framesheet";
import { expectAnimation } from "framesheet/test";

const result = await inspect("banner.svg", { frames: 12 });  // PNG buffers + report
await expectAnimation(page.locator("#mindmap"), "mindmap-open", { frames: 8 }); // visual regression
```

See [js/README.md](js/README.md) for `inspectPage` (components in a running app),
`prepare` (fake clock for JS-driven motion) and server notes.

## The agent loop

1. Run `framesheet inspect FILE --out DIR`.
2. Read the summary, fix every `ERROR` and `WARN`.
3. Look at `full.png` for layout: text clipping, cramped margins, connectors meeting
   card edges, contrast.
4. Look at `sheet.png` for motion: does every tile look intentional? Do the first and
   last tile join up for a loop?
5. Look at `heatmap.png` for unexpected movement: anything coloured that should be still?
6. Use `report.json` for numbers (boxes per frame, changed-pixel ratios, seam ratio).
7. Re-run until clean.

## How time is controlled

framesheet never takes wall-clock screenshots. Everything runs on a virtual clock:

- **SMIL**: `pauseAnimations()` + `setCurrentTime(t)` on every outermost `<svg>`.
- **CSS animations/transitions and Web Animations**: every `document.getAnimations()`
  entry is paused and its `currentTime` set to `t`.
- **JavaScript** (`requestAnimationFrame`, canvas, `Date`, `performance.now`, timers):
  Playwright's fake clock is installed before the page loads and only advances when
  framesheet moves to the next sample time, firing every due timer and rAF callback.

The cycle length is detected from SMIL `begin`/`dur`/`repeatCount` and CSS/Web Animation
timing (delay + duration x iterations, alternate = 2x duration, several loops = least
common multiple when short enough). Override it with `--duration`; with no declarative
animation framesheet samples 3 seconds and tells you so.

## Checks

Static checks (ported from the `svg-animation` skill's `verify_svg.py`): malformed XML,
missing `xmlns`/`viewBox`/title, `<script>`, `on*` handlers, external URLs and fonts,
`<foreignObject>`, duplicate ids, broken `#id`/`url(#id)` references, positive
`<animateMotion begin>`, missing `prefers-reduced-motion`, CSS transforms without
`transform-box`, large files.

Render checks (from geometry at every sampled frame): `parked-at-origin`,
`outside-bounds`, `text-overflow` (SVG text vs. the rect under it; HTML text larger than
its box), `svg-transform-box` (CSS transform animation pivoting around the SVG origin),
`non-seamless-loop`, `js-driven-motion`, `console-error`.

## Repository layout

| Path | What |
| --- | --- |
| `src/framesheet/` | Python package (PyPI `framesheet`) |
| `src/framesheet/runtime.js` | In-page time-control runtime, **shared**: the npm build embeds it byte for byte (CI checks) |
| `js/` | npm package `framesheet` (TypeScript, Playwright peer dependency) |
| `schema/report.schema.json` | JSON Schema of `report.json`, generated from the pydantic models; both implementations are tested against it |
| `schema/golden/` | Python reports for the fixtures; the npm tests compare against them |
| `tests/fixtures/` | Deliberately flawed SVG/HTML, used by both test suites |

## Limitations

- Chromium only. Fonts are whatever the machine has, so text widths can differ from
  macOS/Windows; leave slack in text containers.
- Animations created by script after load are timed from the sample at which framesheet
  first sees them (accurate to one sample step).
- JS clocks run about 17 ms (one frame) ahead of SMIL/CSS time so that rAF content has
  painted at `t=0`.
- Content outside the viewBox is clipped in the images; the report still lists it.
