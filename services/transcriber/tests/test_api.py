from fastapi.testclient import TestClient

from app.engines import UnknownEngineError, available_engines, create_engine
from app.main import app

client = TestClient(app)


def test_probes():
    assert client.get("/healthz").json() == {"status": "ok"}
    assert client.get("/readyz").status_code == 200


def test_engines_lists_the_active_engine():
    body = client.get("/v1/engines").json()
    assert body["active"] == "fake"
    assert body["isMock"] is True
    assert "fake" in body["available"]


def test_transcribe_returns_labelled_mock_segments():
    response = client.post(
        "/v1/transcribe",
        files={"audio": ("meeting.webm", b"\x1a\x45\xdf\xa3fake", "audio/webm")},
        data={"language": "en"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["isMock"] is True
    assert body["segments"][0]["text"].startswith("[mock]")
    assert body["segments"][1]["endMs"] == body["durationMs"]


def test_unknown_engine_fails_clearly():
    try:
        create_engine("whisper-9000")
    except UnknownEngineError as error:
        assert "Available" in str(error)
    else:
        raise AssertionError("expected UnknownEngineError")
    assert available_engines() == ["fake"]
