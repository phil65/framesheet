from pathlib import Path
from typing import TYPE_CHECKING

import pytest

import framesheet


if TYPE_CHECKING:
    from framesheet import InspectionResult


TESTS_DIR = Path(__file__).parent
FIXTURES = TESTS_DIR / "fixtures"


@pytest.fixture(scope="session")
def inspected(tmp_path_factory: pytest.TempPathFactory):
    """Inspect a fixture once per session (keyed by name and options)."""
    cache: dict[tuple, InspectionResult] = {}

    def run(name: str, **kwargs) -> InspectionResult:
        key = (name, tuple(sorted(kwargs.items())))
        if key not in cache:
            out = tmp_path_factory.mktemp(Path(name).stem)
            cache[key] = framesheet.inspect(FIXTURES / name, out=out, **kwargs)
        return cache[key]

    return run
