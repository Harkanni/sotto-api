from collections.abc import Callable
from pathlib import Path
from typing import Literal, Protocol

from app.contracts import TranscriptionResult

DataLocation = Literal["IN_CLUSTER", "THIRD_PARTY"]

#: Called with 0–1 as the engine works through a recording.
Progress = Callable[[float], None]


class TranscriptionEngine(Protocol):
    """One contract for every engine: audio file in, timed segments out.

    The file is always 16 kHz mono WAV (app/audio.py normalises everything first). Engines that
    send audio outside the cluster must say so with `data_location`, so Restricted files are
    refused before they're sent.
    """

    name: str
    model: str
    data_location: DataLocation
    is_mock: bool

    def transcribe(
        self,
        audio_path: Path,
        language: str | None,
        on_progress: Progress | None = None,
    ) -> TranscriptionResult: ...
