# syntax=docker/dockerfile:1
# Transcriber image: ffmpeg (normalises every audio format) + faster-whisper (CTranslate2, fast on
# CPU with int8). The Whisper model is downloaded on first start into /models; mount a volume
# there so restarts and redeploys don't download it again.

FROM python:3.13-slim AS base
# Why: no .pyc clutter, unbuffered logs show up immediately in `docker logs`.
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 UV_LINK_MODE=copy UV_COMPILE_BYTECODE=1

FROM base AS build
# uv installs dependencies from the lockfile in seconds; copied from its official image.
COPY --from=ghcr.io/astral-sh/uv:0.9 /uv /usr/local/bin/uv
WORKDIR /app
COPY pyproject.toml uv.lock* .python-version ./
# Install only runtime deps into /app/.venv (no dev tools in the image).
RUN uv sync --no-dev --no-install-project $( [ -f uv.lock ] && echo --locked )
COPY app ./app

FROM base AS runtime
WORKDIR /app
# ffmpeg from Debian: decodes WebM/Opus (Chrome), MP4/AAC (Safari), MP3, WAV, FLAC, OGG.
# --no-install-recommends keeps out X11 and docs we'd never use.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*
# Why non-root: a compromised process can't modify the image or bind privileged ports.
RUN useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin app \
 && mkdir /models && chown 10001 /models
COPY --from=build /app /app
# The real engine by default; Compose files choose `fake` (a labelled mock) where there's no
# room for a model. HF_HOME and WHISPER_CACHE_DIR point model downloads at the volume.
ENV PATH="/app/.venv/bin:$PATH" TRANSCRIBER_ENGINE=faster-whisper WHISPER_MODEL=base \
    WHISPER_CACHE_DIR=/models HF_HOME=/models
VOLUME /models
USER 10001
EXPOSE 5000
# start-period covers the first model download (base is ~150 MB).
HEALTHCHECK --interval=15s --timeout=3s --start-period=120s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:5000/healthz', timeout=2).status == 200 else 1)"
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "5000", "--proxy-headers"]
