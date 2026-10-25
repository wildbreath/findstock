"""一键启动器辅助函数测试 (不访问外网)。"""

from __future__ import annotations

import json
import socket
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from scripts import launcher


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


class _HealthHandler(BaseHTTPRequestHandler):
    """返回固定的 /api/health 响应。"""

    payload: bytes = b'{"status":"ok","version":"1.0.0"}'
    status_code = 200

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler 接口
        body = self.payload
        self.send_response(self.status_code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args: object) -> None:  # 静默
        pass


@pytest.fixture()
def stub_server():
    """启动一个临时的 HTTP 服务用于探测。"""

    servers: list[tuple[HTTPServer, threading.Thread]] = []

    def start(handler: type[BaseHTTPRequestHandler]) -> int:
        server = HTTPServer(("127.0.0.1", 0), handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        servers.append((server, thread))
        return int(server.server_address[1])

    yield start

    for server, thread in servers:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def test_missing_modules_is_empty_in_this_environment() -> None:
    """运行环境里依赖应当是齐全的, 否则启动器会去装依赖。"""

    assert launcher.missing_modules() == []


def test_port_is_open_detects_listener(stub_server) -> None:
    port = stub_server(_HealthHandler)
    assert launcher.port_is_open("127.0.0.1", port) is True
    assert launcher.port_is_open("127.0.0.1", _free_port()) is False


def test_health_of_recognises_our_server(stub_server) -> None:
    port = stub_server(_HealthHandler)
    payload = launcher.health_of("127.0.0.1", port)
    assert payload is not None
    assert payload["status"] == "ok"


def test_health_of_rejects_other_server(stub_server) -> None:
    """端口上跑着别的服务时不能被误判成本系统。"""

    class _Other(_HealthHandler):
        payload = json.dumps({"hello": "world"}).encode()

    port = stub_server(_Other)
    assert launcher.health_of("127.0.0.1", port) is None


def test_health_of_returns_none_when_nothing_listens() -> None:
    assert launcher.health_of("127.0.0.1", _free_port(), timeout=0.3) is None


def test_find_free_port_skips_busy_port(stub_server) -> None:
    port = stub_server(_HealthHandler)
    assert launcher.find_free_port("127.0.0.1", port) == port + 1


def test_find_free_port_raises_when_exhausted(stub_server) -> None:
    port = stub_server(_HealthHandler)
    with pytest.raises(RuntimeError):
        launcher.find_free_port("127.0.0.1", port, limit=1)


def test_ensure_project_on_path_adds_root() -> None:
    launcher.ensure_project_on_path()
    import sys

    assert str(launcher.PROJECT_ROOT) in sys.path


def test_set_console_title_never_raises() -> None:
    launcher.set_console_title("测试标题")  # 不应抛异常


def test_parse_args_defaults() -> None:
    args = launcher.parse_args([])
    assert args.port == launcher.DEFAULT_PORT
    assert args.no_browser is False
    assert args.reload is False


def test_parse_args_overrides() -> None:
    args = launcher.parse_args(["--port", "9001", "--no-browser", "--skip-deps"])
    assert args.port == 9001
    assert args.no_browser is True
    assert args.skip_deps is True
