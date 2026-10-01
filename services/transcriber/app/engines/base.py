from pathlib import Path
from typing import Literal, Protocol

from app.contracts import TranscriptionResult

DataLocation = Literal["IN_CLUSTER", "THIRD_PARTY"]


class TranscriptionEngine(Protocol):
    """One contract for every engine: audio file in, timed segments out.

    Engines that send audio outside the cluster must say so with `data_location`, so the API can
    refuse them for Restricted files.
    """

    name: str
    data_location: DataLocation
    is_mock: bool

    def transcribe(self, audio_path: Path, language: str | None) -> TranscriptionResult: ...
