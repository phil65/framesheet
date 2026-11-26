"""Regenerate the tiny video fixtures in tests/fixtures/ (needs ffmpeg with libvpx/x264).

    uv run python scripts/video_fixtures.py

square.webm (VP9, 320x180, 10 fps, 6 s): a red square moves right (0-2 s), stands still
(2-4.5 s: a deliberate static stretch), the frame is black (4.5-4.8 s), then the square
moves down. square_gif.gif is the same at 160x90 (decoded with ImageDecoder) and
square_h264.mp4 the same in H.264 (container probing; decodes only where Chromium has
the codec). The files are committed: tests do not need ffmpeg.
"""

from pathlib import Path
import subprocess


FIXTURES = Path(__file__).resolve().parent.parent / "tests" / "fixtures"
SCENE = (
    "[0][1]overlay=x='if(lt(t,2),20+t*90,200)':y='if(lt(t,4.8),70,70+(t-4.8)*60)'"
    ":eval=frame,drawbox=enable='between(t,4.5,4.79)':x=0:y=0:w=iw:h=ih:c=black:t=fill"
)


def ffmpeg(*args: str) -> None:
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", *args], check=True)


def main() -> None:
    webm = FIXTURES / "square.webm"
    ffmpeg(
        "-f", "lavfi", "-i", "color=c=white:s=320x180:r=10:d=6",
        "-f", "lavfi", "-i", "color=c=red:s=40x40:r=10:d=6",
        "-filter_complex", SCENE,
        "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "40", "-g", "30", str(webm),
    )  # fmt: skip
    ffmpeg(
        "-i", str(webm), "-c:v", "libx264", "-pix_fmt", "yuv420p", str(FIXTURES / "square_h264.mp4")
    )
    ffmpeg(
        "-i", str(webm),
        "-vf", "scale=160:90:flags=neighbor,split[a][b];[a]palettegen[p];[b][p]paletteuse",
        str(FIXTURES / "square_gif.gif"),
    )  # fmt: skip
    for name in ("square.webm", "square_h264.mp4", "square_gif.gif"):
        print(FIXTURES / name, (FIXTURES / name).stat().st_size, "bytes")


if __name__ == "__main__":
    main()
