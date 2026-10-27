"""数据同步服务 (API 侧门面)。

真正的下载工作由独立子进程 (``python -m app.cli.sync``) 执行:

* 避免阻塞 Web 进程的事件循环;
* 避免 Windows 上 uvicorn + multiprocessing 的进程重建问题;
* 同步过程即使 Web 服务重启也能继续, 进度通过数据库共享。
"""

from __future__ import annotations

import logging
import subprocess
import uuid
from collections.abc import Sequence
from datetime import date, datetime, timedelta
from pathlib import Path

from app.core.config import Settings
from app.core.errors import ProviderError, SyncAlreadyRunningError
from app.domain.enums import SyncMode, SyncStatus
from app.domain.models import DataCoverage, SyncProgress
from app.providers import create_provider
from app.repositories.bar_repository import BarRepository
from app.repositories.calendar_repository import CalendarRepository
from app.repositories.database import Database
from app.repositories.meta_repository import MetaRepository
from app.repositories.stock_repository import StockRepository
from app.repositories.sync_repository import SyncRepository

logger = logging.getLogger(__name__)


class DataSyncService:
    """本地数据的覆盖情况查询与同步任务管理。"""

    def __init__(
        self,
        settings: Settings,
        database: Database,
        *,
        calendar_repository: CalendarRepository,
        stock_repository: StockRepository,
        bar_repository: BarRepository,
        sync_repository: SyncRepository,
        meta_repository: MetaRepository,
    ) -> None:
        self._settings = settings
        self._db = database
        self._calendar = calendar_repository
        self._stocks = stock_repository
        self._bars = bar_repository
        self._sync = sync_repository
        self._meta = meta_repository

    # --- 覆盖情况 ---------------------------------------------------------

    def coverage(self) -> DataCoverage:
        """返回本地数据覆盖情况。"""

        self._sync.fail_stale_runs()
        bar_start, bar_end = self._bars.bounds()
        return DataCoverage(
            calendar_start=self._calendar.earliest_open_day(),
            calendar_end=self._calendar.latest_open_day(),
            trading_days=self._calendar.count_open_days(),
            bar_start=bar_start,
            bar_end=bar_end,
            bar_count=self._bars.count(),
            stock_count=self._stocks.count(),
            complete_days=self._sync.count_synced_days(),
            last_sync_at=self._sync.last_completed_at(),
        )

    def is_initialized(self) -> bool:
        """是否已经完成过任意一次数据初始化。"""

        return self._calendar.count_open_days() > 0

    # --- 交易日历 ---------------------------------------------------------

    def ensure_calendar(self, *, years: int | None = None) -> int:
        """确保交易日历存在 (为空时联网下载), 返回交易日数量。"""

        existing = self._calendar.count_open_days()
        if existing > 0:
            return existing

        span_years = years or self._settings.history_years
        today = datetime.now().date()
        start = today - timedelta(days=365 * span_years + 30)

        provider = create_provider(
            self._settings.provider,
            timeout=self._settings.request_timeout,
            max_attempts=self._settings.request_retries,
        )
        provider.open()
        try:
            days = provider.fetch_trading_calendar(start, today)
        except Exception as exc:  # noqa: BLE001
            raise ProviderError(f"交易日历下载失败: {exc}") from exc
        finally:
            provider.close()

        with self._db.session() as conn:
            self._calendar.upsert_days(conn, days)
        return sum(1 for _, is_open in days if is_open)

    # --- 同步任务 ---------------------------------------------------------

    def start_sync(
        self,
        mode: SyncMode,
        *,
        target_dates: Sequence[date] | None = None,
    ) -> SyncProgress:
        """启动后台同步子进程。"""

        self._sync.fail_stale_runs()
        running = self._sync.running()
        if running is not None:
            raise SyncAlreadyRunningError(
                f"已有同步任务正在运行 (开始于 {running.started_at:%Y-%m-%d %H:%M:%S}), "
                "请等待其完成或先取消。"
            )

        run_id = uuid.uuid4().hex
        dates = tuple(sorted(set(target_dates or ())))
        self._sync.create_run(
            run_id,
            mode,
            total_days=len(dates),
            phase="spawning",
            message="正在启动同步进程…",
        )

        command = [
            self._settings.python_executable,
            "-m",
            "app.cli.sync",
            "--mode",
            mode.value,
            "--run-id",
            run_id,
        ]
        if dates:
            command += ["--dates", ",".join(day.isoformat() for day in dates)]

        log_path = Path(self._settings.log_dir) / f"sync-{run_id}.log"
        try:
            with log_path.open("ab") as log_file:
                process = subprocess.Popen(  # noqa: S603 - 参数由本模块构造
                    command,
                    cwd=str(self._settings.project_root),
                    stdout=log_file,
                    stderr=subprocess.STDOUT,
                    stdin=subprocess.DEVNULL,
                    creationflags=_no_window_flags(),
                )
        except OSError as exc:
            self._sync.finish(
                run_id, SyncStatus.FAILED, error=f"无法启动同步进程: {exc}"
            )
            raise ProviderError(f"无法启动同步进程: {exc}") from exc

        self._sync.update(run_id, pid=process.pid)
        progress = self._sync.get(run_id)
        assert progress is not None
        logger.info("已启动同步任务 %s (mode=%s, pid=%s)", run_id, mode.value, process.pid)
        return progress

    def progress(self, run_id: str | None = None) -> SyncProgress | None:
        """查询同步进度; 不传编号时返回最近一次任务。"""

        self._sync.fail_stale_runs()
        if run_id:
            return self._sync.get(run_id)
        return self._sync.running() or self._sync.latest()

    def cancel_sync(self, run_id: str | None = None) -> SyncProgress | None:
        """请求取消同步任务。"""

        target = run_id
        if target is None:
            running = self._sync.running()
            if running is None:
                return None
            target = running.run_id
        self._sync.request_cancel(target)
        return self._sync.get(target)


def _no_window_flags() -> int:
    """在 Windows 上避免弹出控制台窗口。"""

    import sys

    if sys.platform == "win32":  # pragma: no cover - 平台相关
        return subprocess.CREATE_NO_WINDOW
    return 0
