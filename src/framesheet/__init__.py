"""framesheet: main package.

Frame-accurate contact sheets and motion maps for animated SVG and HTML, for humans
and AI agents.
"""

from importlib.metadata import version

__version__ = version("framesheet")
__title__ = "framesheet"

__author__ = "Philipp Temminghoff"
__author_email__ = "philipptemminghoff@googlemail.com"
__copyright__ = "Copyright (c) 2026 Philipp Temminghoff"
__license__ = "MIT"
__url__ = "https://github.com/phil65/framesheet"

from framesheet.core import inspect
from framesheet.models import (
    AnimationTiming,
    DurationInfo,
    ElementTrack,
    Finding,
    FrameMetrics,
    Images,
    InspectionResult,
    LoopInfo,
)
from framesheet.render import BrowserNotInstalledError, install_browser

__all__ = [
    "AnimationTiming",
    "BrowserNotInstalledError",
    "DurationInfo",
    "ElementTrack",
    "Finding",
    "FrameMetrics",
    "Images",
    "InspectionResult",
    "LoopInfo",
    "__version__",
    "inspect",
    "install_browser",
]
