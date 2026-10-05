import subprocess
from pathlib import Path

import pytest


def make_audio(path: Path, seconds: float, codec_args: list[str] | None = None) -> Path:
    """A tone with silences, encoded by ffmpeg in whatever container `path` names."""
    subprocess.run(  # noqa: S603 — fixed argv
        [
            "ffmpeg",
            "-nostdin",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"sine=frequency=440:duration={seconds}:sample_rate=44100",
            "-af",
            "volume='if(lt(mod(t,2),1),1,0.05)':eval=frame",  # loud, quiet, loud…
            "-ac",
            "2",
            *(codec_args or []),
            str(path),
        ],
        check=True,
    )
    return path


@pytest.fixture
def audio_dir(tmp_path: Path) -> Path:
    return tmp_path
