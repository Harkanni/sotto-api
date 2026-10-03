"""Engine registry. Add an engine by writing a class that satisfies `TranscriptionEngine` and
registering it here; choose it with TRANSCRIBER_ENGINE. No other code changes."""

from collections.abc import Callable

from app.engines.base import TranscriptionEngine
from app.engines.fake import FakeEngine


def _faster_whisper() -> TranscriptionEngine:
    from app.engines.faster_whisper import FasterWhisperEngine

    return FasterWhisperEngine()


_FACTORIES: dict[str, Callable[[], TranscriptionEngine]] = {
    "fake": FakeEngine,
    "faster-whisper": _faster_whisper,
}


class UnknownEngineError(ValueError):
    pass


def available_engines() -> list[str]:
    return sorted(_FACTORIES)


def create_engine(name: str) -> TranscriptionEngine:
    factory = _FACTORIES.get(name)
    if factory is None:
        raise UnknownEngineError(
            f"Unknown TRANSCRIBER_ENGINE '{name}'. Available: {', '.join(available_engines())}"
        )
    return factory()
