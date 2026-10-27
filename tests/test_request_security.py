"""来源、主机名和远程访问边界，全部使用临时数据库。"""

from dataclasses import replace

import pytest
from fastapi.testclient import TestClient

from app.domain.enums import SyncMode
from app.main import create_app


@pytest.fixture()
def client(container):
    return TestClient(create_app(), client=("127.0.0.1", 50000))


def test_untrusted_host_cannot_read_local_data(client):
    response = client.get("/api/review-sheet", headers={"host": "untrusted.example"})
    assert response.status_code == 400


@pytest.mark.parametrize("headers", [
    {"Origin": "https://untrusted.example"}, {"Origin": "null"},
    {"Sec-Fetch-Site": "cross-site"},
])
def test_cross_site_form_cannot_cancel_a_sync(client, container, headers):
    container.sync_repository.create_run("protected", SyncMode.INCREMENTAL)
    response = client.post("/api/data/sync/cancel", content="", headers={
        **headers, "Content-Type": "application/x-www-form-urlencoded",
    })
    assert response.status_code == 403
    assert container.sync_repository.get("protected").phase == "starting"


def test_same_origin_action_and_local_cli_are_allowed(client, container):
    container.sync_repository.create_run("local", SyncMode.INCREMENTAL)
    assert client.get("/api/health").status_code == 200
    assert client.post("/api/data/sync/cancel", headers={"Origin": "http://testserver"}).status_code == 200
    assert container.sync_repository.get("local").phase == "cancelling"


def test_remote_access_is_disabled_without_a_token(settings):
    client = TestClient(create_app(), client=("192.168.1.20", 50000))
    assert client.get("/api/health").status_code == 403


def test_wildcard_host_configuration_cannot_disable_rebinding_protection(settings, monkeypatch):
    monkeypatch.setattr("app.main.get_settings", lambda: replace(settings, allowed_hosts=("*",)))
    with pytest.raises(ValueError, match="通配符"):
        create_app()


def test_remote_access_requires_credentials_even_for_reads(settings, monkeypatch):
    monkeypatch.setattr("app.main.get_settings", lambda: replace(settings, access_token="test-secret"))
    client = TestClient(create_app(), client=("192.168.1.20", 50000))
    assert client.get("/api/review-sheet").status_code == 401
    assert client.get("/api/health", auth=("user", "wrong")).status_code == 401
    assert client.get("/api/health", auth=("user", "test-secret")).status_code == 200
    assert client.get("/api/health", headers={"Authorization": "Bearer test-secret"}).status_code == 200
    assert client.post("/api/data/sync/cancel", auth=("user", "test-secret"),
                       headers={"Origin": "https://untrusted.example"}).status_code == 403
