import tempfile
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile

from app.contracts import TranscriptionResult
from app.engines import available_engines, create_engine
from app.settings import get_settings

settings = get_settings()
# Fail at startup, not on the first request, if the configured engine doesn't exist.
engine = create_engine(settings.transcriber_engine)

MAX_UPLOAD_BYTES = 512 * 1024 * 1024  # recordings can be long; the queue path streams from S3


@asynccontextmanager
async def lifespan(_: FastAPI):
    yield


app = FastAPI(title="Sotto transcriber", version="1", lifespan=lifespan)


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/readyz")
def readyz() -> dict[str, str]:
    return {"status": "ok", "engine": engine.name}


@app.get("/v1/engines")
def engines() -> dict[str, object]:
    return {
        "active": engine.name,
        "available": available_engines(),
        "dataLocation": engine.data_location,
        "isMock": engine.is_mock,
        "version": settings.app_version,
        "commit": settings.git_sha,
    }


@app.post("/v1/transcribe", response_model=TranscriptionResult)
async def transcribe(
    audio: UploadFile = File(...),  # noqa: B008 — FastAPI's documented pattern
    language: str | None = Form(default=None),  # noqa: B008
) -> TranscriptionResult:
    """Direct transcription for small files and tests. Production audio goes through the queue."""
    suffix = Path(audio.filename or "audio").suffix[:10]
    with tempfile.NamedTemporaryFile(suffix=suffix) as tmp:
        size = 0
        while chunk := await audio.read(1024 * 1024):
            size += len(chunk)
            if size > MAX_UPLOAD_BYTES:
                raise HTTPException(status_code=413, detail="audio too large")
            tmp.write(chunk)
        tmp.flush()
        return engine.transcribe(Path(tmp.name), language)
