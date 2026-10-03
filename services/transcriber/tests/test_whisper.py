"""Real speech through faster-whisper. Needs the model (downloaded on first run) and espeak-ng
to synthesise speech, so it runs only where RUN_WHISPER_TESTS=1 (CI's python job)."""

import os
import shutil
import subprocess
from pathlib import Path

import pytest

from app.audio import normalize

pytestmark = pytest.mark.skipif(
    os.environ.get("RUN_WHISPER_TESTS") != "1" or not shutil.which("espeak-ng"),
    reason="set RUN_WHISPER_TESTS=1 with espeak-ng installed",
)


def test_faster_whisper_hears_words_at_the_right_times(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("WHISPER_MODEL", "tiny")
    from app.engines.faster_whisper import FasterWhisperEngine
    from app.settings import get_settings

    get_settings.cache_clear()
    speech = tmp_path / "speech.wav"
    subprocess.run(  # noqa: S603
        ["espeak-ng", "-w", str(speech), "The board approved the budget on Friday."], check=True
    )
    # Ten seconds of silence first: the words must be found at ~10 s, not at 0.
    padded = tmp_path / "padded.wav"
    subprocess.run(  # noqa: S603
        [
            "ffmpeg",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(speech),
            "-af",
            "adelay=10000",
            str(padded),
        ],
        check=True,
    )
    wav = tmp_path / "audio.wav"
    duration = normalize(padded, wav)
    result = FasterWhisperEngine().transcribe(wav, "en")
    text = " ".join(s.text for s in result.segments).lower()
    assert "board" in text and "budget" in text
    assert 9_000 <= result.segments[0].startMs <= 11_500
    assert abs(result.durationMs - duration) < 200
    assert result.isMock is False
