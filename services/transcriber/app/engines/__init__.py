"""Engine registry. Add an engine by writing a class that satisfies `TranscriptionEngine` and
registering it here; choose it with TRANSCRIBER_ENGINE. No other code changes."""

from app.engines.base import TranscriptionEngine
from app.engines.fake import FakeEngine

_FACTORIES = {
    "fake": FakeEngine,
    # Phase 4: "faster-whisper": FasterWhisperEngine,
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
