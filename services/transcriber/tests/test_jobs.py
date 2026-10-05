import json
from pathlib import Path

import boto3
import pytest
from moto import mock_aws

from app import jobs
from app.contracts import TranscribeRequested, TranscriptionResult
from app.engines.fake import FakeEngine
from app.settings import Settings
from app.storage import Storage
from tests.conftest import make_audio

BUCKET = "sotto-test"
KEY = "files/w1/f1/original.webm"


@pytest.fixture
def storage():
    with mock_aws():
        boto3.client("s3", region_name="eu-west-2").create_bucket(
            Bucket=BUCKET, CreateBucketConfiguration={"LocationConstraint": "eu-west-2"}
        )
        yield Storage(Settings(s3_bucket=BUCKET, s3_region="eu-west-2"))


def put(storage: Storage, path: Path, key: str = KEY) -> None:
    storage._s3.upload_file(str(path), BUCKET, key)


def request(**extra) -> TranscribeRequested:
    return TranscribeRequested(v=1, fileId="f1", workspaceId="w1", storageKey=KEY, **extra)


def read_json(storage: Storage, key: str) -> dict:
    return json.loads(storage._s3.get_object(Bucket=BUCKET, Key=key)["Body"].read())


def test_transcribes_into_storage_next_to_the_original(storage: Storage, tmp_path: Path):
    put(storage, make_audio(tmp_path / "a.webm", 40))
    progress: list[float] = []
    result = jobs.run(request(), FakeEngine(), storage, progress.append)

    assert result.status == "ok"
    assert result.transcriptKey == "files/w1/f1/transcript.json"
    assert result.isMock is True
    assert 39_900 <= result.durationMs <= 40_100
    transcript = TranscriptionResult.model_validate(read_json(storage, result.transcriptKey))
    assert transcript.segments[0].startMs == 0
    assert transcript.segments[-1].endMs == result.durationMs
    peaks = read_json(storage, result.peaksKey)
    assert len(peaks["peaks"]) == 80  # two per second
    assert progress[-1] == 1.0


def test_restricted_recordings_never_reach_an_outside_engine(storage: Storage, tmp_path: Path):
    put(storage, make_audio(tmp_path / "a.webm", 1))
    engine = FakeEngine()
    engine.data_location = "THIRD_PARTY"
    result = jobs.run(request(sensitivity="RESTRICTED"), engine, storage)
    assert result.status == "failed" and result.error == "restricted_engine"
    assert jobs.run(request(sensitivity="CONFIDENTIAL"), engine, storage).status == "ok"


def test_problems_with_the_recording_come_back_as_codes(storage: Storage, tmp_path: Path):
    assert jobs.run(request(), FakeEngine(), storage).error == "storage_missing"
    junk = tmp_path / "junk.webm"
    junk.write_bytes(b"nope")
    put(storage, junk)
    assert jobs.run(request(), FakeEngine(), storage).error == "audio_unreadable"


def test_an_explicit_output_prefix_wins(storage: Storage, tmp_path: Path):
    put(storage, make_audio(tmp_path / "a.webm", 1))
    result = jobs.run(request(outputPrefix="files/w1/f1/v2/"), FakeEngine(), storage)
    assert result.transcriptKey == "files/w1/f1/v2/transcript.json"
