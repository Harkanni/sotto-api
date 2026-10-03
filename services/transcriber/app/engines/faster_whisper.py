"""faster-whisper: Whisper on CTranslate2, fast on CPU with int8 (PLAN: the default engine).

Runs in the cluster; audio never leaves it. The model is chosen by WHISPER_MODEL (tiny, base,
small, medium, large-v3, or a local path) and downloaded once into the model cache volume.
"""

from pathlib import Path

from app.contracts import Segment, TranscriptionResult
from app.engines.base import Progress
from app.settings import get_settings


class FasterWhisperEngine:
    name = "faster-whisper"
    data_location = "IN_CLUSTER"
    is_mock = False

    def __init__(self) -> None:
        # Imported here so the image's other engines and the tests don't pay for loading it.
        from faster_whisper import WhisperModel

        settings = get_settings()
        self.model = settings.whisper_model
        self._model = WhisperModel(
            settings.whisper_model,
            device=settings.whisper_device,
            compute_type=settings.whisper_compute_type,
            cpu_threads=settings.whisper_threads,
            download_root=settings.whisper_cache_dir,
        )
        self._beam_size = settings.whisper_beam_size

    def transcribe(
        self,
        audio_path: Path,
        language: str | None,
        on_progress: Progress | None = None,
    ) -> TranscriptionResult:
        segments, info = self._model.transcribe(
            str(audio_path),
            language=language,
            beam_size=self._beam_size,
            # Skips silence (long pauses, hold music) so it isn't transcribed as noise.
            vad_filter=True,
            condition_on_previous_text=False,  # fewer runaway repetitions on long recordings
        )
        duration_ms = round(info.duration * 1000)
        out: list[Segment] = []
        # `segments` is a generator: transcription happens as it's read, so progress is real.
        for segment in segments:
            text = segment.text.strip()
            if text:
                out.append(
                    Segment(
                        startMs=max(0, round(segment.start * 1000)),
                        endMs=max(0, round(segment.end * 1000)),
                        text=text,
                    )
                )
            if on_progress and duration_ms:
                on_progress(min(1.0, segment.end * 1000 / duration_ms))
        return TranscriptionResult(
            engine=self.name,
            model=self.model,
            language=info.language,
            durationMs=duration_ms,
            isMock=False,
            segments=out,
        )
