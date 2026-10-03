"""Audio preparation with ffmpeg.

Browsers record in different containers (WebM/Opus from Chrome, MP4/AAC from Safari), uploads
arrive as MP3, M4A, WAV and more. Everything is normalised to one format before an engine sees
it (BRIEF §4): 16 kHz, mono, 16-bit PCM WAV, which is what Whisper models expect.
"""

import array
import json
import math
import shutil
import subprocess
from pathlib import Path

SAMPLE_RATE = 16_000
MAX_PEAKS = 2_000


def _tool(name: str) -> str:
    """The absolute path of an ffmpeg tool (the image installs them; see the Dockerfile)."""
    path = shutil.which(name)
    if not path:
        raise RuntimeError(f"{name} is not installed")
    return path


class AudioError(Exception):
    """A recording ffmpeg can't read. `code` is what the file's status shows."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def probe_duration_ms(path: Path) -> int:
    """The container's duration. Some browser WebM files don't record one; 0 means unknown."""
    result = subprocess.run(  # noqa: S603 — fixed argv, no shell
        [
            _tool("ffprobe"),
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "json",
            str(path),
        ],
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    if result.returncode != 0:
        raise AudioError("audio_unreadable")
    try:
        duration = float(json.loads(result.stdout)["format"]["duration"])
    except (KeyError, ValueError, TypeError):
        return 0
    return round(duration * 1000) if math.isfinite(duration) else 0


def normalize(source: Path, target: Path) -> int:
    """Converts any input to 16 kHz mono WAV. Returns the true duration in milliseconds."""
    result = subprocess.run(  # noqa: S603 — fixed argv, no shell
        [
            _tool("ffmpeg"),
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(source),
            "-vn",  # a video track (a screen recording) is dropped, not decoded
            "-ac",
            "1",
            "-ar",
            str(SAMPLE_RATE),
            "-c:a",
            "pcm_s16le",
            str(target),
        ],
        capture_output=True,
        timeout=60 * 60,
        check=False,
    )
    if result.returncode != 0 or not target.exists():
        raise AudioError("audio_unreadable")
    samples = (target.stat().st_size - 44) // 2  # 44-byte WAV header, 2 bytes per sample
    if samples <= 0:
        raise AudioError("audio_empty")
    return round(samples * 1000 / SAMPLE_RATE)


def peaks(wav: Path, duration_ms: int, buckets: int | None = None) -> list[float]:
    """Loudness per bucket for the player's waveform: the peak of each slice, scaled so the
    loudest slice is 1, with a square-root curve so quiet speech still shows."""
    count = buckets or max(1, min(MAX_PEAKS, duration_ms // 500))  # about two per second
    total = (wav.stat().st_size - 44) // 2
    if total <= 0:
        return [0.0] * count
    per_bucket = max(1, math.ceil(total / count))
    values: list[int] = []
    with wav.open("rb") as handle:
        handle.seek(44)
        chunk = array.array("h")
        while len(values) < count:
            raw = handle.read(per_bucket * 2)
            if not raw:
                break
            chunk = array.array("h")
            chunk.frombytes(raw[: len(raw) - len(raw) % 2])
            values.append(max((abs(s) for s in chunk), default=0))
    values += [0] * (count - len(values))
    loudest = max(values) or 1
    return [round(math.sqrt(v / loudest), 3) for v in values]
