from functools import lru_cache
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Read from the environment."""

    model_config = SettingsConfigDict(env_prefix="", extra="ignore")

    transcriber_engine: str = "fake"
    log_level: Literal["debug", "info", "warning", "error"] = "info"
    app_version: str = "0.0.0-dev"
    git_sha: str = "local"

    # The queue. Unset → only the HTTP endpoints run (tests, local experiments).
    rabbitmq_url: str | None = None

    # Object storage, the same settings as the api and worker (packages/storage).
    s3_bucket: str = "sotto-files"
    s3_region: str = "eu-west-2"
    s3_endpoint: str | None = None
    s3_access_key_id: str | None = None
    s3_secret_access_key: str | None = None
    s3_force_path_style: bool | None = None

    # faster-whisper. `base` with int8 runs on a small CPU server at several times real time.
    whisper_model: str = "base"
    whisper_device: str = "cpu"
    whisper_compute_type: str = "int8"
    whisper_threads: int = 0  # 0 → all cores
    whisper_beam_size: int = 5
    whisper_cache_dir: str | None = None


@lru_cache
def get_settings() -> Settings:
    return Settings()
