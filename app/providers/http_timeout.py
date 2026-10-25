"""给 akshare 的 HTTP 请求补上默认超时。

akshare 内部大量 ``requests.get(...)`` 没有传 ``timeout`` (全库 259 处),
上游一旦不响应, 调用线程就会**永久阻塞**; 实测新浪对个别次新股/存托凭证
不返回数据时就会卡住整批任务。

这里在 ``requests.Session.request`` 层面注入默认超时: 只在调用方
**没有显式指定** ``timeout`` 时生效, 不改变任何已有行为, 属于对第三方库
缺失能力的兼容补丁。只安装一次, 线程安全。
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar

import requests

logger = logging.getLogger(__name__)

DEFAULT_TIMEOUT_SECONDS = 20.0

_lock = threading.Lock()
_installed = False
_timeout = DEFAULT_TIMEOUT_SECONDS
_request_check: ContextVar[Callable[[], None] | None] = ContextVar("request_check", default=None)


@contextmanager
def guard_requests(check: Callable[[], None]) -> Iterator[None]:
    """仅约束当前调用上下文，第三方库内部翻页和重试同样先检查。"""
    if not _installed:
        install_default_timeout(_timeout)
    token = _request_check.set(check)
    try:
        yield
    finally:
        _request_check.reset(token)


def install_default_timeout(seconds: float = DEFAULT_TIMEOUT_SECONDS) -> None:
    """安装默认超时 (幂等)。重复调用只会更新超时数值。"""

    global _installed, _timeout
    with _lock:
        _timeout = max(1.0, float(seconds))
        if _installed:
            return
        _installed = True

    original_request = requests.Session.request
    original_send = requests.Session.send

    def request_with_timeout(self, method, url, **kwargs):  # type: ignore[no-untyped-def]
        kwargs.setdefault("timeout", _timeout)
        return original_request(self, method, url, **kwargs)

    def checked_send(self, request, **kwargs):  # type: ignore[no-untyped-def]
        check = _request_check.get()
        if check is not None:
            check()
        return original_send(self, request, **kwargs)

    requests.Session.request = request_with_timeout  # type: ignore[method-assign]
    requests.Session.send = checked_send  # type: ignore[method-assign]
    logger.debug("已为 requests 安装默认超时: %.0fs", _timeout)


def default_timeout() -> float:
    """当前生效的默认超时 (秒)。"""

    return _timeout


def is_installed() -> bool:
    """是否已经安装过补丁。"""

    return _installed
