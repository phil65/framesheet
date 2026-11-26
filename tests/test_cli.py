"""CLI smoke tests."""

import json

from typer.testing import CliRunner

from framesheet.cli import app
from tests.conftest import FIXTURES


runner = CliRunner()


def test_inspect_summary(tmp_path):
    result = runner.invoke(
        app, ["inspect", str(FIXTURES / "non_seamless.svg"), "--out", str(tmp_path), "-n", "6"]
    )
    assert result.exit_code == 0, result.output
    assert "loop: NOT seamless" in result.output
    assert "non-seamless-loop" in result.output
    assert (tmp_path / "sheet.png").is_file()


def test_inspect_json_stdin(tmp_path):
    svg = (FIXTURES / "parked_dot.svg").read_text()
    result = runner.invoke(
        app, ["inspect", "-", "--json", "--out", str(tmp_path), "-n", "4"], input=svg
    )
    assert result.exit_code == 0, result.output
    data = json.loads(result.output)
    assert data["source"] == "-"
    assert any(f["code"] == "parked-at-origin" for f in data["findings"])


def test_errors_set_exit_code(tmp_path):
    bad = tmp_path / "bad.svg"
    bad.write_text('<svg xmlns="http://www.w3.org/2000/svg"><title>x</title></svg>')
    result = runner.invoke(app, ["inspect", str(bad), "--out", str(tmp_path / "o"), "-n", "2"])
    assert result.exit_code == 1
    assert "missing-viewbox" in result.output


def test_multiple_inputs_get_subdirs(tmp_path):
    result = runner.invoke(
        app,
        [
            "inspect",
            str(FIXTURES / "fly_out.svg"),
            str(FIXTURES / "finite.svg"),
            "--out",
            str(tmp_path),
            "-n",
            "3",
        ],
    )
    assert result.exit_code == 0, result.output
    assert (tmp_path / "fly_out" / "report.json").is_file()
    assert (tmp_path / "finite" / "report.json").is_file()


def test_missing_file_and_bad_size(tmp_path):
    assert runner.invoke(app, ["inspect", str(tmp_path / "nope.svg")]).exit_code == 2
    result = runner.invoke(app, ["inspect", str(FIXTURES / "finite.svg"), "--size", "huge"])
    assert result.exit_code == 2
