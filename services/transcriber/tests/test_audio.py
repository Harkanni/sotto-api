from pathlib import Path

import pytest

from app.audio import AudioError, normalize, peaks, probe_duration_ms
from tests.conftest import make_audio


@pytest.mark.parametrize("name", ["call.mp3", "memo.m4a", "browser.webm", "raw.wav"])
def test_normalises_every_browser_format(audio_dir: Path, name: str):
    source = make_audio(audio_dir / name, 3)
    target = audio_dir / "out.wav"
    duration = normalize(source, target)
    assert 2_900 <= duration <= 3_100
    # 16 kHz mono 16-bit: 32,000 bytes a second after the header.
    assert abs((target.stat().st_size - 44) / 32_000 - duration / 1000) < 0.01
    assert abs(probe_duration_ms(source) - duration) < 150


def test_peaks_follow_the_loudness(audio_dir: Path):
    wav = audio_dir / "out.wav"
    duration = normalize(make_audio(audio_dir / "a.mp3", 4), wav)
    values = peaks(wav, duration, buckets=8)
    assert len(values) == 8
    assert max(values) == 1.0
    # Seconds 0–1 and 2–3 are loud; 1–2 and 3–4 are quiet.
    assert values[0] > 0.8 and values[2] < 0.4


def test_unreadable_audio_has_a_code(audio_dir: Path):
    junk = audio_dir / "junk.webm"
    junk.write_bytes(b"not audio at all")
    with pytest.raises(AudioError) as error:
        normalize(junk, audio_dir / "out.wav")
    assert error.value.code == "audio_unreadable"
