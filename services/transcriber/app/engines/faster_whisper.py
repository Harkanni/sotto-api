"""faster-whisper: Whisper on CTranslate2, fast on CPU with int8 (PLAN: the default engine).

Runs in the cluster; audio never leaves it. The model is chosen by WHISPER_MODEL (tiny, base,
small, medium, large-v3, or a local path) and downloaded once into the model cache volume.

The engine reads the normalised WAV itself, in windows (20 minutes by default), and hands the
model plain sample arrays. Two reasons: memory stays bounded however long the meeting (a whole
two-hour recording as float32 would be ~460 MB), and faster-whisper's own decoder (PyAV) is
skipped, so its version drift can't break transcription.
"""

import wave
from pathlib import Path

import numpy as np

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
        self._window_s = max(60, settings.whisper_window_minutes * 60)

    def transcribe(
        self,
        audio_path: Path,
        language: str | None,
        on_progress: Progress | None = None,
    ) -> TranscriptionResult:
        out: list[Segment] = []
        detected = language
        with wave.open(str(audio_path), "rb") as wav:
            rate = wav.getframerate()
            total = wav.getnframes()
            duration_ms = round(total * 1000 / rate)
            window = self._window_s * rate
            for start in range(0, total, window):
                frames = wav.readframes(window)
                samples = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
                offset_ms = round(start * 1000 / rate)
                segments, info = self._model.transcribe(
                    samples,
                    # The first window detects the language; the rest keep it, so a quiet
                    # stretch can't flip the transcript into another language mid-meeting.
                    language=detected,
                    beam_size=self._beam_size,
                    # Skips silence (long pauses, hold music) so it isn't transcribed as noise.
                    vad_filter=True,
                    condition_on_previous_text=False,  # fewer runaway repetitions
                )
                detected = detected or info.language
                # `segments` is a generator: transcription happens as it's read.
                for segment in segments:
                    text = segment.text.strip()
                    if text:
                        out.append(
                            Segment(
                                startMs=offset_ms + max(0, round(segment.start * 1000)),
                                endMs=offset_ms + max(0, round(segment.end * 1000)),
                                text=text,
                            )
                        )
                    if on_progress and duration_ms:
                        done = offset_ms + segment.end * 1000
                        on_progress(min(1.0, done / duration_ms))
        return TranscriptionResult(
            engine=self.name,
            model=self.model,
            language=detected or "en",
            durationMs=duration_ms,
            isMock=False,
            segments=out,
        )
