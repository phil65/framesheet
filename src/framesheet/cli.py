"""Command line interface: ``framesheet inspect FILE...``."""

from __future__ import annotations

import json
from pathlib import Path
import re
import sys
from typing import Annotated, Literal

import typer

from framesheet.render import BrowserNotInstalledError, install_browser


app = typer.Typer(
    name="framesheet",
    help="Frame-accurate contact sheets and motion maps for animated SVG and HTML.",
    no_args_is_help=True,
    add_completion=False,
)


def _out_for(base: Path | None, source: str, multiple: bool) -> Path | None:
    if base is None or not multiple:
        return base
    stem = "stdin" if source == "-" else re.sub(r"[^\w.-]+", "_", Path(source).stem)[:60]
    return base / stem


def _parse_times(value: str | None) -> list[float] | Literal["marks"] | None:
    if value is None:
        return None
    if value.strip() == "marks":
        return "marks"
    try:
        return [float(v) for v in value.split(",") if v.strip()]
    except ValueError:
        msg = f"Invalid --times {value!r}: expected seconds like 1.2,3.4 or 'marks'"
        raise typer.BadParameter(msg, param_hint="--times") from None


@app.command("inspect")
def inspect_cmd(
    sources: Annotated[
        list[str],
        typer.Argument(
            help="SVG/HTML files, videos (mp4, webm, mov, mkv, animated gif/webp), "
            "http(s):// URLs, or - for stdin."
        ),
    ],
    frames: Annotated[int, typer.Option("--frames", "-n", help="Contact-sheet tiles.")] = 12,
    duration: Annotated[
        float | None, typer.Option(help="Cycle length in seconds (default: detected).")
    ] = None,
    at: Annotated[
        float | None,
        typer.Option(help="Time (s) of the full-resolution frame (default: 0 / range start)."),
    ] = None,
    size: Annotated[
        str | None, typer.Option(help="Viewport WxH (default: SVG size or 1280x720).")
    ] = None,
    scale: Annotated[float | None, typer.Option(help="Device scale factor.")] = None,
    out: Annotated[
        Path | None, typer.Option("--out", "-o", help="Output dir (default: new temp dir).")
    ] = None,
    tile: Annotated[
        int | None, typer.Option(help="Longest side of a sheet tile in px (default: auto).")
    ] = None,
    columns: Annotated[int | None, typer.Option(help="Sheet columns.")] = None,
    keep_frames: Annotated[bool, typer.Option(help="Also write every frame to frames/.")] = False,
    dark: Annotated[bool, typer.Option(help="Emulate prefers-color-scheme: dark.")] = False,
    as_json: Annotated[bool, typer.Option("--json", help="Print only the JSON report.")] = False,
    heat_frames: Annotated[
        int, typer.Option(help="Extra pixel-only samples (heatmap; videos: pacing checks).")
    ] = 48,
    every: Annotated[
        float | None, typer.Option(help="Video: one tile every SECONDS (instead of -n).")
    ] = None,
    times: Annotated[
        str | None,
        typer.Option(help="Video: tile times, e.g. 1.2,3.4 (or 'marks': from --marks)."),
    ] = None,
    start: Annotated[float | None, typer.Option(help="Video: range start (s).")] = None,
    end: Annotated[float | None, typer.Option(help="Video: range end (s).")] = None,
    marks: Annotated[
        Path | None, typer.Option(help="Video: marks.json to draw (points, regions, spans).")
    ] = None,
    static_stretch: Annotated[
        float, typer.Option(help="Video: seconds without change reported as dead time.")
    ] = 2.0,
    channel: Annotated[
        str | None, typer.Option(help="Browser channel, e.g. chrome (H.264 decoding).")
    ] = None,
) -> None:
    """Render inputs at evenly spaced times and check them.

    Writes full.png, sheet.png, heatmap.png and report.json per input and prints a
    summary. Exits 1 if any error-level finding was reported.
    """
    from framesheet.core import inspect
    from framesheet.sources import parse_size

    try:
        viewport = parse_size(size) if size else None
    except ValueError as exc:
        raise typer.BadParameter(str(exc), param_hint="--size") from None
    tile_times = _parse_times(times)
    results = []
    for source in sources:
        try:
            result = inspect(
                source,
                frames=frames,
                duration=duration,
                size=viewport,
                scale=scale,
                at=at,
                out=_out_for(out, source, len(sources) > 1),
                tile=tile,
                columns=columns,
                keep_frames=keep_frames,
                color_scheme="dark" if dark else "light",
                heat_frames=heat_frames,
                every=every,
                times=tile_times,
                start=start,
                end=end,
                marks=marks,
                static_stretch=static_stretch,
                channel=channel,
            )
        except BrowserNotInstalledError as exc:
            typer.echo(f"error: {exc}", err=True)
            raise typer.Exit(2) from None
        except (FileNotFoundError, ValueError) as exc:
            typer.echo(f"error: {exc}", err=True)
            raise typer.Exit(2) from None
        results.append(result)
        if not as_json:
            typer.echo(result.summary())
            if len(sources) > 1:
                typer.echo("")
    if as_json:
        payload = [r.model_dump(mode="json") for r in results]
        sys.stdout.write(json.dumps(payload[0] if len(payload) == 1 else payload, indent=2) + "\n")
    if any(r.errors for r in results):
        raise typer.Exit(1)


@app.command("install-browser")
def install_browser_cmd() -> None:
    """Install Playwright's Chromium for this Python environment."""
    raise typer.Exit(install_browser())


def main() -> None:
    app()


if __name__ == "__main__":
    main()
