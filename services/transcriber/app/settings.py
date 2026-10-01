from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Read from the environment. Phase 1 ships only the labelled mock engine."""

    model_config = SettingsConfigDict(env_prefix="", extra="ignore")

    transcriber_engine: str = "fake"
    log_level: Literal["debug", "info", "warning", "error"] = "info"
    app_version: str = "0.0.0-dev"
    git_sha: str = "local"


def get_settings() -> Settings:
    return Settings()
