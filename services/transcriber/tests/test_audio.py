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


def write_wav(path: Path, levels: list[int], seconds_each: float = 1.0) -> Path:
    """A 16 kHz mono WAV: each level held for `seconds_each`, as a square wave."""
    import array
    import wave

    samples = array.array("h")
    for level in levels:
        n = int(16_000 * seconds_each)
        samples.extend((level if i % 40 < 20 else -level) for i in range(n))
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16_000)
        w.writeframes(samples.tobytes())
    return path


def test_peaks_follow_the_loudness(audio_dir: Path):
    wav = write_wav(audio_dir / "levels.wav", [20_000, 1_000, 20_000, 1_000])
    values = peaks(wav, 4_000, buckets=4)
    assert values[0] == values[2] == 1.0
    # Quiet is a twentieth of loud; the square-root curve keeps it visible, not a sliver.
    assert 0.2 < values[1] < 0.3 and 0.2 < values[3] < 0.3


def test_unreadable_audio_has_a_code(audio_dir: Path):
    junk = audio_dir / "junk.webm"
    junk.write_bytes(b"not audio at all")
    with pytest.raises(AudioError) as error:
        normalize(junk, audio_dir / "out.wav")
    assert error.value.code == "audio_unreadable"


def test_one_loud_click_doesnt_flatten_the_waveform(audio_dir: Path):
    wav = write_wav(audio_dir / "click.wav", [3_000] * 4)
    with wav.open("r+b") as f:  # a click at the very start
        f.seek(44 + 20)
        f.write((32_000).to_bytes(2, "little", signed=True))
    values = peaks(wav, 4_000, buckets=8)
    assert values[0] == 1.0
    assert min(values[1:]) > 0.9  # the steady speech level reads as full, not as a sliver
