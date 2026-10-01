# syntax=docker/dockerfile:1
# Transcriber image. Small on purpose: the mock engine needs nothing heavy. Phase 4 adds ffmpeg and
# faster-whisper (and a model cache volume).

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
# Why non-root: a compromised process can't modify the image or bind privileged ports.
RUN useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin app
COPY --from=build /app /app
ENV PATH="/app/.venv/bin:$PATH" TRANSCRIBER_ENGINE=fake
USER 10001
EXPOSE 5000
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:5000/healthz', timeout=2).status == 200 else 1)"
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "5000", "--proxy-headers"]
