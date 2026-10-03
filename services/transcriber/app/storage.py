"""Object storage (S3 on AWS, SeaweedFS locally): read originals, write derived files."""

from pathlib import Path

import boto3
from botocore.config import Config

from app.settings import Settings


class Storage:
    def __init__(self, settings: Settings):
        endpoint = settings.s3_endpoint or None  # an empty variable means "AWS"
        path_style = (
            settings.s3_force_path_style
            if settings.s3_force_path_style is not None
            else bool(endpoint)
        )
        kwargs: dict[str, object] = {
            "region_name": settings.s3_region,
            "config": Config(
                s3={"addressing_style": "path" if path_style else "auto"},
                retries={"max_attempts": 5, "mode": "standard"},
                # Plain requests that every S3-compatible server accepts (as in packages/storage).
                request_checksum_calculation="when_required",
                response_checksum_validation="when_required",
            ),
        }
        if endpoint:
            kwargs["endpoint_url"] = endpoint
        if settings.s3_access_key_id and settings.s3_secret_access_key:
            kwargs["aws_access_key_id"] = settings.s3_access_key_id
            kwargs["aws_secret_access_key"] = settings.s3_secret_access_key
        self._s3 = boto3.client("s3", **kwargs)
        self.bucket = settings.s3_bucket

    def download(self, key: str, target: Path) -> None:
        """Streams to disk: a two-hour recording never sits in memory."""
        self._s3.download_file(self.bucket, key, str(target))

    def put_json(self, key: str, body: str) -> None:
        self._s3.put_object(
            Bucket=self.bucket, Key=key, Body=body.encode(), ContentType="application/json"
        )
