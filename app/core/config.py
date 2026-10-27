"""应用配置。

所有可变参数集中在此处, 通过环境变量覆盖, 便于测试与部署。
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]


def _env_path(name: str, default: Path) -> Path:
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    return Path(raw).expanduser().resolve()


def _env_int(name: str, default: int, *, minimum: int = 1) -> int:
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    try:
        value = int(raw)
    except ValueError as exc:  # pragma: no cover - defensive
        raise ValueError(f"环境变量 {name} 必须是整数, 实际为 {raw!r}") from exc
    if value < minimum:
        raise ValueError(f"环境变量 {name} 必须 >= {minimum}, 实际为 {value}")
    return value


@dataclass(frozen=True, slots=True)
class Settings:
    """运行时配置。"""

    project_root: Path
    data_dir: Path
    database_path: Path
    web_dir: Path
    log_dir: Path
    history_years: int
    sync_workers: int
    sync_chunk_size: int
    provider: str
    request_timeout: float
    request_retries: int
    python_executable: str
    allowed_hosts: tuple[str, ...] = ("127.0.0.1", "localhost", "[::1]")
    access_token: str = ""

    def ensure_directories(self) -> None:
        """确保数据/日志目录存在。"""

        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.log_dir.mkdir(parents=True, exist_ok=True)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """返回进程级配置单例。"""

    data_dir = _env_path("FINDSTOCK_DATA_DIR", PROJECT_ROOT / "data")
    return Settings(
        project_root=PROJECT_ROOT,
        data_dir=data_dir,
        database_path=_env_path("FINDSTOCK_DB_PATH", data_dir / "findstock.sqlite3"),
        web_dir=_env_path("FINDSTOCK_WEB_DIR", PROJECT_ROOT / "web"),
        log_dir=_env_path("FINDSTOCK_LOG_DIR", PROJECT_ROOT / "logs"),
        history_years=_env_int("FINDSTOCK_HISTORY_YEARS", 2),
        # akshare 走 HTTP, 用线程并发即可; 并发过高容易被上游限流。
        sync_workers=_env_int("FINDSTOCK_SYNC_WORKERS", 8),
        sync_chunk_size=_env_int("FINDSTOCK_SYNC_CHUNK_SIZE", 40),
        provider=os.getenv("FINDSTOCK_PROVIDER", "akshare").strip() or "akshare",
        request_timeout=float(os.getenv("FINDSTOCK_REQUEST_TIMEOUT", "20")),
        request_retries=_env_int("FINDSTOCK_REQUEST_RETRIES", 3),
        python_executable=os.getenv("FINDSTOCK_PYTHON") or sys.executable,
        allowed_hosts=("127.0.0.1", "localhost", "[::1]", *(
            host.strip() for host in os.getenv("FINDSTOCK_ALLOWED_HOSTS", "").split(",")
            if host.strip()
        )),
        access_token=os.getenv("FINDSTOCK_ACCESS_TOKEN", ""),
    )
