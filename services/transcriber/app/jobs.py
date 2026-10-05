"""One transcription, start to finish, with no queue in sight (the consumer handles that):

original in storage → ffmpeg → 16 kHz mono WAV → engine → transcript.json + peaks.json
"""

import logging
import posixpath
import tempfile
from collections.abc import Callable
from pathlib import Path

from botocore.exceptions import ClientError

from app.audio import AudioError, normalize, peaks
from app.contracts import (
    Peaks,
    TranscribeCompletedFailed,
    TranscribeCompletedOk,
    TranscribeRequested,
)
from app.engines.base import TranscriptionEngine
from app.storage import Storage

log = logging.getLogger("transcriber")

Completed = TranscribeCompletedOk | TranscribeCompletedFailed


def output_prefix(request: TranscribeRequested) -> str:
    """Derived files sit next to the original (files/<workspace>/<file>/)."""
    if request.outputPrefix:
        return request.outputPrefix
    return posixpath.dirname(request.storageKey) + "/"


def run(
    request: TranscribeRequested,
    engine: TranscriptionEngine,
    storage: Storage,
    on_progress: Callable[[float], None] | None = None,
) -> Completed:
    """Raises only for transient trouble (storage unreachable) so the caller can retry; every
    problem with the recording itself comes back as a `failed` result with a code."""

    def failed(code: str) -> TranscribeCompletedFailed:
        return TranscribeCompletedFailed(
            fileId=request.fileId, workspaceId=request.workspaceId, engine=engine.name, error=code
        )

    # BRIEF §3: Restricted recordings never leave the cluster, whatever engine is configured.
    if request.sensitivity == "RESTRICTED" and engine.data_location != "IN_CLUSTER":
        return failed("restricted_engine")

    with tempfile.TemporaryDirectory(prefix="sotto-") as tmp:
        original = Path(tmp) / ("original" + Path(request.storageKey).suffix[:8])
        try:
            storage.download(request.storageKey, original)
        except ClientError as error:
            if error.response.get("Error", {}).get("Code") in {"404", "NoSuchKey", "NotFound"}:
                return failed("storage_missing")
            raise

        wav = Path(tmp) / "audio.wav"
        try:
            duration_ms = normalize(original, wav)
        except AudioError as error:
            return failed(error.code)
        original.unlink(missing_ok=True)  # free the disk before the engine runs

        try:
            result = engine.transcribe(wav, request.language, on_progress)
        except Exception as error:  # an engine bug or a model that can't load: logged by kind
            log.error(
                "engine failed", extra={"fileId": request.fileId, "error": type(error).__name__}
            )
            return failed("transcription_failed")

        # The WAV's length is the truth; containers recorded in browsers often have none.
        duration_ms = duration_ms or result.durationMs
        for segment in result.segments:
            segment.endMs = min(max(segment.endMs, segment.startMs), duration_ms)
            segment.startMs = min(segment.startMs, segment.endMs)
        result.durationMs = duration_ms

        prefix = output_prefix(request)
        transcript_key = prefix + "transcript.json"
        peaks_key = prefix + "peaks.json"
        storage.put_json(transcript_key, result.model_dump_json())
        storage.put_json(
            peaks_key,
            Peaks(durationMs=duration_ms, peaks=peaks(wav, duration_ms)).model_dump_json(),
        )

    return TranscribeCompletedOk(
        fileId=request.fileId,
        workspaceId=request.workspaceId,
        transcriptKey=transcript_key,
        peaksKey=peaks_key,
        engine=engine.name,
        model=engine.model,
        durationMs=duration_ms,
        isMock=engine.is_mock,
    )
