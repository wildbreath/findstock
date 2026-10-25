"""同步任务命令行入口。

用法::

    python -m app.cli.sync --mode full --run-id <id>
    python -m app.cli.sync --mode targeted --run-id <id> --dates 2026-09-14,2026-09-15,2026-09-16
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
from datetime import date

from app.container import Container
from app.core.config import get_settings
from app.core.logging import configure_logging
from app.domain.enums import SyncMode
from app.services.sync_engine import SyncEngine

logger = logging.getLogger(__name__)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    """解析命令行参数。"""

    parser = argparse.ArgumentParser(description="沪深A股数据同步任务")
    parser.add_argument(
        "--mode",
        required=True,
        choices=[mode.value for mode in SyncMode],
        help="同步模式",
    )
    parser.add_argument("--run-id", required=True, help="任务编号 (与数据库记录对应)")
    parser.add_argument(
        "--dates",
        default="",
        help="targeted 模式下的交易日列表, 逗号分隔 (yyyy-mm-dd)",
    )
    return parser.parse_args(argv)


def parse_dates(raw: str) -> tuple[date, ...]:
    """解析逗号分隔的日期。"""

    items = [item.strip() for item in raw.split(",") if item.strip()]
    return tuple(date.fromisoformat(item) for item in items)


def main(argv: list[str] | None = None) -> int:
    """任务入口。"""

    args = parse_args(argv)
    settings = get_settings()
    configure_logging(settings)
    container = Container.build(settings)

    mode = SyncMode(args.mode)
    target_dates = parse_dates(args.dates)
    if mode is SyncMode.TARGETED and not target_dates:
        logger.error("targeted 模式必须提供 --dates")
        return 2

    # 允许从命令行直接运行: 若任务记录不存在则自动登记, 进度与网页端共享。
    if container.sync_repository.get(args.run_id) is None:
        container.sync_repository.create_run(
            args.run_id,
            mode,
            total_days=len(target_dates),
            pid=os.getpid(),
            phase="cli",
            message="命令行任务已启动",
        )
    else:
        # 记录进程号, 这样进程意外退出时能被识别为 "已失效任务",
        # 不会永久占住 "正在运行" 状态而挡住后续任务。
        container.sync_repository.update(args.run_id, pid=os.getpid())

    engine = SyncEngine(
        settings,
        container.database,
        calendar_repository=container.calendar_repository,
        stock_repository=container.stock_repository,
        bar_repository=container.bar_repository,
        sync_repository=container.sync_repository,
        meta_repository=container.meta_repository,
    )
    engine.run(
        mode,
        args.run_id,
        target_dates=target_dates,
    )
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
