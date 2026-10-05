from pathlib import Path

from app.contracts import Segment, TranscriptionResult
from app.engines.base import Progress

SAMPLE_RATE = 16_000
STEP_MS = 15_000


class FakeEngine:
    """MOCK engine: no model, no recognition. It emits a labelled placeholder line every 15
    seconds across the recording's real length, so the pipeline, the player and the transcript
    view can be exercised end to end. Output is flagged `isMock` so the UI labels it."""

    name = "fake"
    model = "none"
    data_location = "IN_CLUSTER"
    is_mock = True

    def transcribe(
        self,
        audio_path: Path,
        language: str | None,
        on_progress: Progress | None = None,
    ) -> TranscriptionResult:
        # A normalised WAV is 2 bytes per sample after a 44-byte header; anything else (the
        # direct /v1/transcribe test endpoint) counts as 4.5 seconds.
        size = audio_path.stat().st_size
        duration = (
            round((size - 44) / 2 * 1000 / SAMPLE_RATE) if audio_path.suffix == ".wav" else 4_500
        )
        duration = max(duration, 1)
        segments = []
        for i, start in enumerate(range(0, duration, STEP_MS)):
            end = min(duration, start + STEP_MS)
            text = "[mock] This is a placeholder transcript." if i == 0 else f"[mock] Line {i + 1}."
            segments.append(Segment(startMs=start, endMs=end, text=text))
            if on_progress:
                on_progress(end / duration)
        return TranscriptionResult(
            engine=self.name,
            model=self.model,
            language=language or "en",
            durationMs=duration,
            isMock=True,
            segments=segments,
        )
