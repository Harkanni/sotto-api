"""Mirror of packages/contracts (TypeScript). Keep the two in step; bump `v` on breaking changes."""

from typing import Literal

from pydantic import BaseModel, Field

Sensitivity = Literal["INTERNAL", "CONFIDENTIAL", "RESTRICTED"]

QUEUE_REQUESTED = "transcribe.requested"
QUEUE_PROGRESS = "transcribe.progress"
QUEUE_COMPLETED = "transcribe.completed"
QUEUE_DEAD = "sotto.dead"


class TranscribeRequested(BaseModel):
    v: Literal[1]
    fileId: str = Field(min_length=1)  # noqa: N815 — matches the wire format
    workspaceId: str = Field(min_length=1)  # noqa: N815
    storageKey: str = Field(min_length=1)  # noqa: N815
    language: str | None = None
    outputPrefix: str | None = None  # noqa: N815
    sensitivity: Sensitivity | None = None


class TranscribeProgress(BaseModel):
    v: Literal[1] = 1
    fileId: str  # noqa: N815
    workspaceId: str  # noqa: N815
    progress: float = Field(ge=0, le=1)


class TranscribeCompletedOk(BaseModel):
    v: Literal[1] = 1
    status: Literal["ok"] = "ok"
    fileId: str  # noqa: N815
    workspaceId: str  # noqa: N815
    transcriptKey: str  # noqa: N815
    peaksKey: str | None = None  # noqa: N815
    engine: str
    model: str
    durationMs: int = Field(ge=0)  # noqa: N815
    isMock: bool = False  # noqa: N815


class TranscribeCompletedFailed(BaseModel):
    v: Literal[1] = 1
    status: Literal["failed"] = "failed"
    fileId: str  # noqa: N815
    workspaceId: str  # noqa: N815
    engine: str
    # A short machine-readable reason. Never audio content or transcript text.
    error: str = Field(max_length=200)


class Segment(BaseModel):
    startMs: int = Field(ge=0)  # noqa: N815
    endMs: int = Field(ge=0)  # noqa: N815
    text: str
    speaker: str | None = None


class TranscriptionResult(BaseModel):
    """Also the shape of transcript.json in storage (TranscriptDocument in TypeScript)."""

    engine: str
    model: str
    language: str
    durationMs: int = Field(ge=0)  # noqa: N815
    isMock: bool = False  # noqa: N815
    segments: list[Segment]


class Peaks(BaseModel):
    """peaks.json: loudness per bucket, 0–1, for the player's waveform."""

    durationMs: int = Field(ge=0)  # noqa: N815
    peaks: list[float] = Field(max_length=4096)
