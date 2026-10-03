"""The faster-whisper engine's windowing, with a stand-in model (no download needed)."""

from pathlib import Path
from types import SimpleNamespace

from app.audio import normalize
from app.engines.faster_whisper import FasterWhisperEngine
from tests.conftest import make_audio


class StandInModel:
    """Says one line per window, at 1–2 s into it; reports the language it was told, or 'en'."""

    def __init__(self):
        self.calls: list[dict] = []

    def transcribe(self, samples, **kwargs):
        self.calls.append({"seconds": len(samples) / 16_000, **kwargs})
        info = SimpleNamespace(language=kwargs.get("language") or "en")
        return iter([SimpleNamespace(start=1.0, end=2.0, text=f" window {len(self.calls)} ")]), info


def engine_with(model: StandInModel, window_s: int) -> FasterWhisperEngine:
    engine = FasterWhisperEngine.__new__(FasterWhisperEngine)  # skip loading a real model
    engine.model = "stand-in"
    engine._model = model
    engine._beam_size = 1
    engine._window_s = window_s
    return engine


def test_long_audio_is_transcribed_in_windows_with_true_times(tmp_path: Path):
    wav = tmp_path / "audio.wav"
    normalize(make_audio(tmp_path / "a.webm", 50), wav)
    model = StandInModel()
    progress: list[float] = []
    result = engine_with(model, 20).transcribe(wav, None, progress.append)

    assert [round(c["seconds"]) for c in model.calls] == [20, 20, 10]
    # Each window's times are shifted by where the window starts.
    assert [s.startMs for s in result.segments] == [1_000, 21_000, 41_000]
    assert [s.text for s in result.segments] == ["window 1", "window 2", "window 3"]
    # The language found in the first window is kept for the rest.
    assert [c["language"] for c in model.calls] == [None, "en", "en"]
    assert result.language == "en"
    assert 49_900 <= result.durationMs <= 50_100
    assert progress == sorted(progress)
