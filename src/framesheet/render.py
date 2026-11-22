"""Playwright/Chromium session with frame-accurate time control.

Time is virtual. Three mechanisms are driven to the same target time ``t``:

* JavaScript clocks (``Date``, ``performance.now``, ``setTimeout``, ``requestAnimationFrame``)
  run on Playwright's fake clock, installed before navigation and paused. Moving to ``t``
  calls ``page.clock.run_for(delta)``, which fires every due timer and rAF callback in
  order, so canvas/rAF animations advance deterministically.
* SMIL: every outermost ``<svg>`` gets ``pauseAnimations()`` + ``setCurrentTime(t)``.
* CSS animations/transitions and Web Animations: ``document.getAnimations()`` are paused
  and ``currentTime`` is set to ``t`` (relative to when the animation first appeared).
"""

from __future__ import annotations

from dataclasses import dataclass, field
import datetime as dt
from importlib.resources import files
import io
import subprocess
import sys
from typing import TYPE_CHECKING, Any, Self

from PIL import Image


if TYPE_CHECKING:
    from types import TracebackType

    from playwright.sync_api import Browser, Page, Playwright

    from framesheet.models import ColorScheme
    from framesheet.sources import Source


INSTALL_HINT = (
    "Chromium for Playwright is not installed. Run `framesheet install-browser` "
    "(or `uv run playwright install chromium`)."
)
_EPOCH = dt.datetime(2025, 1, 1, tzinfo=dt.UTC)
_RUNTIME_JS = files("framesheet").joinpath("runtime.js").read_text(encoding="utf-8")
_FIRST_FRAME_MS = 17
_LAUNCH_ARGS = [
    # Compositor-thread animations race with pause(): keep them on the main thread.
    "--disable-threaded-animation",
    "--hide-scrollbars",
    "--force-color-profile=srgb",
    "--disable-lcd-text",
]


class BrowserNotInstalledError(RuntimeError):
    """Raised when Playwright's Chromium is missing."""

    def __init__(self) -> None:
        super().__init__(INSTALL_HINT)


def install_browser() -> int:
    """Install Playwright's Chromium for the running Python environment."""
    cmd = [sys.executable, "-m", "playwright", "install", "chromium"]
    return subprocess.run(cmd, check=False).returncode


@dataclass
class Snapshot:
    """Everything captured at one sample time."""

    t: float
    image: Image.Image
    geometry: list[Any]
    """``[index, clientRect, userRect | None, visible]`` per rendered element."""
    overflow: list[Any] = field(default_factory=list)
    """HTML text overflow: ``[index, dx, dy]``."""


class Session:
    """One browser page showing one input, with a virtual clock starting at ``t=0``."""

    def __init__(
        self,
        source: Source,
        *,
        size: tuple[int, int],
        scale: float = 1.0,
        color_scheme: ColorScheme = "light",
        timeout: float = 30.0,
    ) -> None:
        self.source = source
        self.size = size
        self.scale = scale
        self.color_scheme = color_scheme
        self.timeout_ms = timeout * 1000
        self.console_errors: list[str] = []
        self.response_text: str | None = None
        self._now_ms = 0
        self._pw: Playwright | None = None
        self._browser: Browser | None = None
        self._page: Page | None = None

    def __enter__(self) -> Self:
        from playwright.sync_api import Error, sync_playwright

        self._pw = sync_playwright().start()
        try:
            self._browser = self._pw.chromium.launch(args=_LAUNCH_ARGS)
        except Error as exc:
            self._pw.stop()
            if "Executable doesn't exist" in str(exc) or "playwright install" in str(exc):
                raise BrowserNotInstalledError from None
            raise
        context = self._browser.new_context(
            viewport={"width": self.size[0], "height": self.size[1]},
            device_scale_factor=self.scale,
            color_scheme=self.color_scheme,
            reduced_motion="no-preference",
            locale="en-US",
            timezone_id="UTC",
        )
        page = context.new_page()
        page.set_default_timeout(self.timeout_ms)
        page.on("pageerror", lambda exc: self.console_errors.append(f"pageerror: {exc}"))
        page.on(
            "console",
            lambda msg: (
                self.console_errors.append(f"console.{msg.type}: {msg.text}")
                if msg.type == "error"
                else None
            ),
        )
        # pause_at() installs the fake clock itself. A separate install() first would let
        # the real time between the two calls leak into performance.now() (Playwright
        # replays that interval as running time), shifting rAF-driven frames per run.
        page.clock.pause_at(_EPOCH + dt.timedelta(seconds=1))
        self._page = page
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        if self._browser:
            self._browser.close()
        if self._pw:
            self._pw.stop()

    @property
    def page(self) -> Page:
        assert self._page is not None, "Session not entered"
        return self._page

    def js(self, expression: str, arg: Any = None) -> Any:
        return self.page.evaluate(expression, arg)

    def load(self) -> None:
        response = self.page.goto(self.source.url, wait_until="load")
        if response is not None and self.source.text is None:
            try:
                self.response_text = response.text()
            except Exception:  # noqa: BLE001
                self.response_text = None
        self.js(_RUNTIME_JS)
        self.js("() => window.__framesheet.ready()")
        # Let one fake animation frame run so rAF-driven content has painted at t=0.
        # (JS clocks are therefore ~17 ms ahead of SMIL/CSS time.)
        self.page.clock.run_for(_FIRST_FRAME_MS)
        self.seek(0.0)

    def seek(self, t: float) -> None:
        """Move all clocks to virtual time ``t`` (seconds). Time only moves forward."""
        target = round(t * 1000)
        if target < self._now_ms:
            msg = f"Cannot seek backwards ({t}s < {self._now_ms / 1000}s)"
            raise ValueError(msg)
        if target > self._now_ms:
            self.page.clock.run_for(target - self._now_ms)
            self._now_ms = target
        self.js("t => window.__framesheet.seek(t)", t)
        self.js("() => window.__framesheet.settle()")

    def screenshot(self, t: float) -> Image.Image:
        """Pixels only, at virtual time ``t``."""
        self.seek(t)
        png = self.page.screenshot(type="png", caret="hide", animations="allow", scale="device")
        return Image.open(io.BytesIO(png)).convert("RGB")

    def snapshot(self, t: float, *, overflow: bool = False) -> Snapshot:
        """Pixels plus element geometry at virtual time ``t``."""
        image = self.screenshot(t)
        geometry = self.js("() => window.__framesheet.measure()")
        over = self.js("() => window.__framesheet.htmlOverflow()") if overflow else []
        return Snapshot(t=t, image=image, geometry=geometry, overflow=over)
