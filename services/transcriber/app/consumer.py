"""The queue side: consume transcribe.requested, run the job in a thread, publish progress and
the result. aio-pika keeps the connection's heartbeats going while a long recording is being
transcribed in the background thread, so the broker never drops us mid-job.

Queues are declared exactly as the api and worker declare them (durable, no arguments).
"""

import asyncio
import json
import logging
import time

import aio_pika
from aio_pika.abc import AbstractIncomingMessage, AbstractRobustChannel
from pydantic import ValidationError

from app import jobs
from app.contracts import (
    QUEUE_COMPLETED,
    QUEUE_DEAD,
    QUEUE_PROGRESS,
    QUEUE_REQUESTED,
    TranscribeCompletedFailed,
    TranscribeProgress,
    TranscribeRequested,
)
from app.engines.base import TranscriptionEngine
from app.storage import Storage

log = logging.getLogger("transcriber")

MAX_ATTEMPTS = 3
#: Progress messages at most this often, and only when it moved by at least PROGRESS_STEP.
PROGRESS_EVERY_S = 3.0
PROGRESS_STEP = 0.02


class Consumer:
    def __init__(self, url: str, engine: TranscriptionEngine, storage: Storage):
        self.url = url
        self.engine = engine
        self.storage = storage
        self.channel: AbstractRobustChannel | None = None
        self.connected = False

    async def publish(self, queue: str, body: str, headers: dict | None = None) -> None:
        assert self.channel is not None
        await self.channel.default_exchange.publish(
            aio_pika.Message(
                body.encode(),
                content_type="application/json",
                delivery_mode=aio_pika.DeliveryMode.PERSISTENT,
                headers=headers or {},
            ),
            routing_key=queue,
        )

    async def handle(self, message: AbstractIncomingMessage) -> None:
        try:
            request = TranscribeRequested.model_validate_json(message.body)
        except (ValidationError, json.JSONDecodeError):
            log.warning("rejected message", extra={"reason": "invalid_shape"})
            await self.publish(
                QUEUE_DEAD, message.body.decode(errors="replace"), {"queue": QUEUE_REQUESTED}
            )
            await message.ack()
            return

        attempt = int((message.headers or {}).get("x-attempt", 1))
        loop = asyncio.get_running_loop()
        last = {"value": 0.0, "at": 0.0}

        def on_progress(value: float) -> None:
            # Called from the engine's thread; hops back to the event loop to publish.
            now = time.monotonic()
            if value - last["value"] < PROGRESS_STEP or now - last["at"] < PROGRESS_EVERY_S:
                return
            last.update(value=value, at=now)
            body = TranscribeProgress(
                fileId=request.fileId, workspaceId=request.workspaceId, progress=round(value, 3)
            ).model_dump_json()
            asyncio.run_coroutine_threadsafe(self.publish(QUEUE_PROGRESS, body), loop)

        started = time.monotonic()
        try:
            result = await asyncio.to_thread(
                jobs.run, request, self.engine, self.storage, on_progress
            )
        except Exception as error:  # storage or broker trouble: worth another try
            log.warning(
                "job failed",
                extra={"fileId": request.fileId, "attempt": attempt, "error": type(error).__name__},
            )
            if attempt < MAX_ATTEMPTS:
                await asyncio.sleep(2 * 4 ** (attempt - 1))
                await self.publish(
                    QUEUE_REQUESTED, message.body.decode(), {"x-attempt": attempt + 1}
                )
            else:
                failed = TranscribeCompletedFailed(
                    fileId=request.fileId,
                    workspaceId=request.workspaceId,
                    engine=self.engine.name,
                    error="transcription_failed",
                )
                await self.publish(QUEUE_COMPLETED, failed.model_dump_json())
                await self.publish(QUEUE_DEAD, message.body.decode(), {"queue": QUEUE_REQUESTED})
            await message.ack()
            return

        await self.publish(QUEUE_COMPLETED, result.model_dump_json())
        await message.ack()
        log.info(
            "transcribed",
            extra={
                "fileId": request.fileId,
                "status": result.status,
                "seconds": round(time.monotonic() - started, 1),
            },
        )

    async def run(self) -> None:
        connection = await aio_pika.connect_robust(self.url)
        channel = await connection.channel()
        # One recording at a time per process: transcription uses every core already.
        await channel.set_qos(prefetch_count=1)
        for name in (QUEUE_REQUESTED, QUEUE_PROGRESS, QUEUE_COMPLETED, QUEUE_DEAD):
            await channel.declare_queue(name, durable=True)
        self.channel = channel
        connection.close_callbacks.add(lambda *_: setattr(self, "connected", False))
        connection.reconnect_callbacks.add(lambda *_: setattr(self, "connected", True))
        queue = await channel.get_queue(QUEUE_REQUESTED)
        await queue.consume(self.handle)
        self.connected = True
        log.info("consuming", extra={"engine": self.engine.name, "model": self.engine.model})
