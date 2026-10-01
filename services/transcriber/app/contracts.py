"""Mirror of packages/contracts (TypeScript). Keep the two in step; bump `v` on breaking changes."""

from typing import Literal

from pydantic import BaseModel, Field


class TranscribeRequested(BaseModel):
    v: Literal[1]
    fileId: str = Field(min_length=1)  # noqa: N815 — matches the wire format
    workspaceId: str = Field(min_length=1)  # noqa: N815
    storageKey: str = Field(min_length=1)  # noqa: N815
    language: str | None = None


class Segment(BaseModel):
    startMs: int = Field(ge=0)  # noqa: N815
    endMs: int = Field(ge=0)  # noqa: N815
    text: str
    speaker: str | None = None


class TranscriptionResult(BaseModel):
    engine: str
    model: str
    language: str
    durationMs: int = Field(ge=0)  # noqa: N815
    isMock: bool = False  # noqa: N815
    segments: list[Segment]
