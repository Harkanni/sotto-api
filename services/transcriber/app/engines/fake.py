from pathlib import Path

from app.contracts import Segment, TranscriptionResult


class FakeEngine:
    """MOCK engine: returns fixed segments without reading audio. Used until Phase 4 adds
    faster-whisper, and in tests. Its output is flagged `isMock` so the UI can label it."""

    name = "fake"
    data_location = "IN_CLUSTER"
    is_mock = True

    def transcribe(self, audio_path: Path, language: str | None) -> TranscriptionResult:
        segments = [
            Segment(startMs=0, endMs=2_000, text="[mock] This is a placeholder transcript."),
            Segment(startMs=2_000, endMs=4_500, text=f"[mock] Source file: {audio_path.name}."),
        ]
        return TranscriptionResult(
            engine=self.name,
            model="none",
            language=language or "en",
            durationMs=4_500,
            isMock=True,
            segments=segments,
        )
