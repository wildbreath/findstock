"""日志配置。"""

from __future__ import annotations

import logging
import logging.handlers
import sys
from pathlib import Path

from app.core.config import Settings

_LOG_FORMAT = "%(asctime)s | %(levelname)-7s | %(name)s | %(message)s"
_CONFIGURED = False


def configure_logging(settings: Settings, *, level: int = logging.INFO) -> None:
    """配置根日志器 (幂等)。"""

    global _CONFIGURED
    if _CONFIGURED:
        return

    settings.ensure_directories()
    formatter = logging.Formatter(_LOG_FORMAT)

    console = logging.StreamHandler(sys.stderr)
    console.setFormatter(formatter)

    file_handler = logging.handlers.RotatingFileHandler(
        Path(settings.log_dir) / "findstock.log",
        maxBytes=5 * 1024 * 1024,
        backupCount=5,
        encoding="utf-8",
    )
    file_handler.setFormatter(formatter)

    root = logging.getLogger()
    root.setLevel(level)
    root.handlers.clear()
    root.addHandler(console)
    root.addHandler(file_handler)

    # 第三方库的常规日志只保留告警, 避免淹没同步进度。
    logging.getLogger("akshare").setLevel(logging.WARNING)
    logging.getLogger("urllib3").setLevel(logging.WARNING)
    _CONFIGURED = True


def get_logger(name: str) -> logging.Logger:
    """获取命名日志器。"""

    return logging.getLogger(name)
