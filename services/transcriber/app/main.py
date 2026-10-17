import asyncio
import contextlib
import logging
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, Response, UploadFile

from app.consumer import Consumer
from app.contracts import TranscriptionResult
from app.engines import available_engines, create_engine
from app.settings import get_settings
from app.storage import Storage

settings = get_settings()
logging.basicConfig(level=settings.log_level.upper(), format="%(levelname)s %(name)s %(message)s")
# Fail at startup, not on the first request, if the configured engine doesn't exist or its model
# can't load.
engine = create_engine(settings.transcriber_engine)
consumer = (
    Consumer(settings.rabbitmq_url, engine, Storage(settings)) if settings.rabbitmq_url else None
)

MAX_UPLOAD_BYTES = 512 * 1024 * 1024  # the direct endpoint; the queue path streams from S3


async def _connect_forever(c: Consumer) -> None:
    """Keeps trying until the broker answers (it may start after us)."""
    delay = 1.0
    while True:
        try:
            await c.run()
            return
        except Exception as error:  # noqa: BLE001 — any connection failure means "try again"
            logging.getLogger("transcriber").warning(
                "queue not reachable yet", extra={"error": type(error).__name__}
            )
            await asyncio.sleep(delay)
            delay = min(delay * 2, 30)


@asynccontextmanager
async def lifespan(_: FastAPI):
    task = asyncio.create_task(_connect_forever(consumer)) if consumer else None
    yield
    if task:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task


app = FastAPI(title="Sotto transcriber", version="1", lifespan=lifespan)


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/readyz")
def readyz(response: Response) -> dict[str, str]:
    """Ready once the engine is loaded and, when a queue is configured, connected to it."""
    if consumer and not consumer.connected:
        response.status_code = 503
        return {"status": "connecting", "engine": engine.name}
    return {"status": "ok", "engine": engine.name}


@app.get("/v1/engines")
def engines() -> dict[str, object]:
    return {
        "active": engine.name,
        "model": engine.model,
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
    in_cluster_only: bool = Form(default=False),  # noqa: B008
) -> TranscriptionResult:
    """Direct transcription: live chunks (Listen mode, the notetaker bot), small files and tests.
    Recorded files go through the queue.

    `in_cluster_only` marks Restricted audio: it's refused (409) if this engine sends audio
    outside the cluster, whatever the caller believed about the engine a moment ago.
    """
    if in_cluster_only and engine.data_location != "IN_CLUSTER":
        raise HTTPException(status_code=409, detail="engine sends audio outside the cluster")
    suffix = Path(audio.filename or "audio").suffix[:10]
    with tempfile.NamedTemporaryFile(suffix=suffix) as tmp:
        size = 0
        while chunk := await audio.read(1024 * 1024):
            size += len(chunk)
            if size > MAX_UPLOAD_BYTES:
                raise HTTPException(status_code=413, detail="audio too large")
            tmp.write(chunk)
        tmp.flush()
        return await asyncio.to_thread(engine.transcribe, Path(tmp.name), language)
