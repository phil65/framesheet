"""The shared report schema (schema/report.schema.json) matches the Python models.

The npm package (js/) validates its reports against the same file and compares them with
the golden Python reports in schema/golden/. Regenerate both with
``uv run python scripts/sync_schema.py --golden``.
"""

from __future__ import annotations

import json
from pathlib import Path
import re

import pytest

from framesheet.models import FINDING_CODES, report_schema
from tests.conftest import FIXTURES


ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src" / "framesheet"
SCHEMA = ROOT / "schema" / "report.schema.json"
GOLDEN = ROOT / "schema" / "golden"
# Code literals as they appear in checks.py / analysis.py / core.py.
_CODE_PATTERNS = [
    re.compile(r'_finding\(\s*"(?:error|warning|info)",\s*"([a-z][a-z-]+)"'),
    re.compile(r'_finding\(\s*"(?!(?:error|warning|info)")([a-z][a-z-]+)",'),
    re.compile(r'code="([a-z][a-z-]+)"'),
    re.compile(r'finding\(\s*"(?:error|warning|info)",\s*"([a-z][a-z-]+)"'),
]


def test_committed_schema_is_current():
    committed = json.loads(SCHEMA.read_text(encoding="utf-8"))
    assert committed == report_schema(), (
        "schema/report.schema.json is stale: run `uv run python scripts/sync_schema.py`"
    )


def test_every_emitted_code_is_registered():
    found: set[str] = set()
    for name in ("checks.py", "analysis.py", "core.py"):
        text = (SRC / name).read_text(encoding="utf-8")
        for pattern in _CODE_PATTERNS:
            found |= set(pattern.findall(text))
    assert found, "no finding codes found in the sources (pattern drift?)"
    assert found <= set(FINDING_CODES), found - set(FINDING_CODES)
    assert all(re.fullmatch(r"[a-z]+(-[a-z]+)*", code) for code in FINDING_CODES)


@pytest.mark.parametrize("path", sorted(GOLDEN.glob("*.json")), ids=lambda p: p.stem)
def test_golden_reports_match_schema_shape(path: Path):
    """Golden reports have exactly the schema's fields (cheap structural check)."""
    schema = report_schema()
    report = json.loads(path.read_text(encoding="utf-8"))
    assert set(report) == set(schema["properties"])
    finding = set(schema["$defs"]["Finding"]["properties"])
    for item in report["findings"]:
        assert set(item) == finding
        assert item["code"] in FINDING_CODES
    assert any(FIXTURES.glob(f"{path.stem}.*")), f"no fixture for golden report {path.name}"
