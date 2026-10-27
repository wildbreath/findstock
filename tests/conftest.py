"""pytest 公共夹具。"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest

from app.container import Container
from app.core.config import Settings, get_settings


@pytest.fixture()
def settings(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Settings]:
    """把数据目录重定向到临时目录, 避免测试污染真实数据。"""

    data_dir = tmp_path / "data"
    monkeypatch.setenv("FINDSTOCK_DATA_DIR", str(data_dir))
    monkeypatch.setenv("FINDSTOCK_DB_PATH", str(data_dir / "test.sqlite3"))
    monkeypatch.setenv("FINDSTOCK_LOG_DIR", str(tmp_path / "logs"))
    monkeypatch.setenv("FINDSTOCK_SYNC_WORKERS", "1")
    monkeypatch.setenv("FINDSTOCK_ALLOWED_HOSTS", "127.0.0.1,localhost,[::1],testserver")
    monkeypatch.delenv("FINDSTOCK_ACCESS_TOKEN", raising=False)
    get_settings.cache_clear()
    resolved = get_settings()
    yield resolved
    get_settings.cache_clear()


@pytest.fixture()
def container(settings: Settings) -> Container:
    """构建指向临时数据库的依赖容器。"""

    return Container.build(settings)
