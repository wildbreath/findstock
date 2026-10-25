"""requests 默认超时补丁测试。"""

from __future__ import annotations

from threading import Thread

import pytest
import requests

from app.core.errors import DataNotAvailableError
from app.providers import http_timeout


def test_install_is_idempotent(monkeypatch) -> None:
    """重复安装只更新数值, 不会层层包裹。"""

    monkeypatch.setattr(http_timeout, "_installed", False)
    monkeypatch.setattr(requests.Session, "request", lambda self, m, u, **kw: "ok")
    wrapped_once = requests.Session.request

    http_timeout.install_default_timeout(7.5)
    http_timeout.install_default_timeout(3.0)

    assert http_timeout.is_installed() is True
    assert http_timeout.default_timeout() == 3.0
    assert requests.Session.request is not wrapped_once, "第一次安装应当包裹原函数"


def test_timeout_is_injected_only_when_missing(monkeypatch) -> None:
    """没有显式 timeout 时注入默认值; 显式指定时必须保持原样。"""

    captured: list[dict] = []

    def recorder(self, method, url, **kwargs):  # type: ignore[no-untyped-def]
        captured.append(kwargs)
        return "ok"

    monkeypatch.setattr(http_timeout, "_installed", False)
    monkeypatch.setattr(requests.Session, "request", recorder)
    http_timeout.install_default_timeout(3.0)

    session = requests.Session()
    session.request("GET", "http://example.invalid")
    session.request("GET", "http://example.invalid", timeout=99)

    assert captured[0]["timeout"] == 3.0
    assert captured[1]["timeout"] == 99


def test_akshare_provider_installs_the_patch(monkeypatch) -> None:
    """构造数据源时就应当补上超时, 不需要调用方记得这件事。"""

    monkeypatch.setattr(http_timeout, "_installed", False)
    from app.providers.akshare_provider import AkshareProvider

    AkshareProvider(timeout=12.5)

    assert http_timeout.is_installed() is True
    assert http_timeout.default_timeout() == 12.5


def test_request_guard_blocks_transport_and_restores_context(monkeypatch):
    sent = []
    monkeypatch.setattr(http_timeout, "_installed", False)
    monkeypatch.setattr(requests.Session, "send", lambda self, request, **kw: sent.append(request))
    http_timeout.install_default_timeout()
    session = requests.Session()

    def closed():
        raise DataNotAvailableError("已收盘")

    with pytest.raises(DataNotAvailableError):
        with http_timeout.guard_requests(closed):
            session.send("blocked")
    assert sent == []
    session.send("local-context-finished")
    assert sent == ["local-context-finished"]


def test_request_guards_are_nested_and_do_not_block_other_threads(monkeypatch):
    sent = []
    monkeypatch.setattr(http_timeout, "_installed", False)
    monkeypatch.setattr(requests.Session, "send", lambda self, request, **kw: sent.append(request))
    http_timeout.install_default_timeout()

    def closed():
        raise DataNotAvailableError("已收盘")

    with http_timeout.guard_requests(closed):
        with http_timeout.guard_requests(lambda: None):
            requests.Session().send("inner")
        with pytest.raises(DataNotAvailableError):
            requests.Session().send("outer")
        worker = Thread(target=lambda: requests.Session().send("other-thread"))
        worker.start()
        worker.join(timeout=2)
        assert not worker.is_alive()
    assert sent == ["inner", "other-thread"]


def test_redirect_cannot_send_another_request_after_window_closes(monkeypatch):
    sent = []
    monkeypatch.setattr(http_timeout, "_installed", False)
    allowed = [True]

    def send(adapter, request, **kwargs):
        sent.append(request.url)
        allowed[0] = False
        response = requests.Response()
        response.status_code = 302
        response.headers["Location"] = "https://example.invalid/after-close"
        response.url = request.url
        response.request = request
        response._content = b""
        response._content_consumed = True
        return response

    def check():
        if not allowed[0]:
            raise DataNotAvailableError("已收盘")

    monkeypatch.setattr(requests.adapters.HTTPAdapter, "send", send)
    http_timeout.install_default_timeout()
    with http_timeout.guard_requests(check), pytest.raises(DataNotAvailableError):
        requests.get("https://example.invalid/before-close")
    assert sent == ["https://example.invalid/before-close"]
