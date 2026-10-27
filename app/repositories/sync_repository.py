"""数据同步任务仓储。"""

from __future__ import annotations

import sqlite3
from datetime import UTC, date, datetime, timedelta
from typing import Any

from app.core.errors import SyncAlreadyRunningError
from app.domain.enums import SyncMode, SyncStatus
from app.domain.models import SyncProgress
from app.repositories.database import Database
from app.repositories.mappers import parse_date

_UPDATABLE_FIELDS = frozenset(
    {"phase", "total_stocks", "done_stocks", "total_days", "done_days", "message", "error", "pid"}
)


def _now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def _parse_dt(value: object) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value))
    except ValueError:
        return None


class SyncRepository:
    """读写 ``sync_run`` 与 ``synced_day`` 表。"""

    def __init__(self, database: Database) -> None:
        self._db = database

    # --- sync_run ---------------------------------------------------------

    def create_run(
        self,
        run_id: str,
        mode: SyncMode,
        *,
        total_days: int = 0,
        total_stocks: int = 0,
        pid: int | None = None,
        phase: str = "starting",
        message: str | None = None,
    ) -> None:
        """在同一写事务中检查并占用唯一的运行名额。"""

        with self._db.session() as conn:
            conn.execute("BEGIN IMMEDIATE")
            if conn.execute("SELECT 1 FROM sync_run WHERE status = 'running' LIMIT 1").fetchone():
                raise SyncAlreadyRunningError("已有同步任务正在运行或取消中，请等待其退出。")
            conn.execute(
                """
                INSERT INTO sync_run (
                    run_id, mode, status, phase, started_at, total_stocks,
                    done_stocks, total_days, done_days, message, pid
                ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, 0, ?, ?)
                """,
                (
                    run_id,
                    mode.value,
                    SyncStatus.RUNNING.value,
                    phase,
                    _now_iso(),
                    total_stocks,
                    total_days,
                    message,
                    pid,
                ),
            )

    def update(self, run_id: str, **fields: Any) -> None:
        """更新进度字段 (白名单)。"""

        unknown = set(fields) - _UPDATABLE_FIELDS
        if unknown:
            raise ValueError(f"不支持更新的字段: {sorted(unknown)}")
        if not fields:
            return
        assignments = ", ".join(
            f"{name} = CASE WHEN phase = 'cancelling' THEN {name} ELSE ? END"
            if name in {"phase", "message"} else f"{name} = ?"
            for name in fields
        )
        with self._db.session() as conn:
            conn.execute(
                f"UPDATE sync_run SET {assignments} WHERE run_id = ?",
                [*fields.values(), run_id],
            )

    def finish(
        self,
        run_id: str,
        status: SyncStatus,
        *,
        message: str | None = None,
        error: str | None = None,
    ) -> None:
        """标记任务结束。"""

        with self._db.session() as conn:
            conn.execute("BEGIN IMMEDIATE")
            current = conn.execute("SELECT status, phase FROM sync_run WHERE run_id = ?", (run_id,)).fetchone()
            if current is None or current["status"] != SyncStatus.RUNNING.value:
                return
            if status is SyncStatus.SUCCEEDED and current["phase"] == "cancelling":
                status = SyncStatus.CANCELLED
                message = "任务已被用户取消。"
            conn.execute(
                "UPDATE sync_run SET status = ?, finished_at = ?, message = ?, "
                "error = ?, phase = ? WHERE run_id = ?",
                (status.value, _now_iso(), message, error, status.value, run_id),
            )

    def request_cancel(self, run_id: str) -> bool:
        """请求取消，保留运行名额，直到工作进程确认停止。"""

        with self._db.session() as conn:
            cursor = conn.execute(
                "UPDATE sync_run SET phase = ?, message = ? "
                "WHERE run_id = ? AND status = ? AND phase != 'cancelling'",
                (
                    "cancelling",
                    "已请求取消, 等待当前批次结束…",
                    run_id,
                    SyncStatus.RUNNING.value,
                ),
            )
        return (cursor.rowcount or 0) > 0

    def get(self, run_id: str) -> SyncProgress | None:
        """按编号读取任务。"""

        with self._db.session() as conn:
            row = conn.execute(
                "SELECT * FROM sync_run WHERE run_id = ?", (run_id,)
            ).fetchone()
        return _row_to_progress(row) if row else None

    def latest(self) -> SyncProgress | None:
        """最近一次任务。"""

        with self._db.session() as conn:
            row = conn.execute(
                "SELECT * FROM sync_run ORDER BY started_at DESC LIMIT 1"
            ).fetchone()
        return _row_to_progress(row) if row else None

    def running(self) -> SyncProgress | None:
        """当前正在运行的任务 (若有)。"""

        with self._db.session() as conn:
            row = conn.execute(
                "SELECT * FROM sync_run WHERE status = ? ORDER BY started_at DESC LIMIT 1",
                (SyncStatus.RUNNING.value,),
            ).fetchone()
        return _row_to_progress(row) if row else None

    def fail_stale_runs(self) -> int:
        """把进程已消失的 running 任务标记为失败 (避免界面永久卡住)。"""

        with self._db.session() as conn:
            rows = conn.execute(
                "SELECT run_id, pid, started_at FROM sync_run WHERE status = ?",
                (SyncStatus.RUNNING.value,),
            ).fetchall()
            stale = [
                row["run_id"]
                for row in rows
                if (
                    row["pid"] is not None and not _pid_alive(int(row["pid"]))
                ) or (
                    row["pid"] is None
                    and (_parse_dt(row["started_at"]) or datetime.now(UTC))
                    < datetime.now(UTC) - timedelta(minutes=2)
                )
            ]
            if stale:
                conn.executemany(
                    "UPDATE sync_run SET status = ?, phase = ?, finished_at = ?, "
                    "error = ? WHERE run_id = ?",
                    [
                        (
                            SyncStatus.FAILED.value,
                            SyncStatus.FAILED.value,
                            _now_iso(),
                            "同步进程已退出",
                            run_id,
                        )
                        for run_id in stale
                    ],
                )
        return len(stale)

    # --- synced_day -------------------------------------------------------

    def mark_day_synced(
        self, conn: sqlite3.Connection, day: date, bar_count: int
    ) -> None:
        """标记某个交易日已完整下载。"""

        conn.execute(
            "INSERT INTO synced_day (trade_date, bar_count, completed_at) "
            "VALUES (?, ?, ?) ON CONFLICT(trade_date) DO UPDATE SET "
            "bar_count = excluded.bar_count, completed_at = excluded.completed_at",
            (day.isoformat(), bar_count, _now_iso()),
        )

    def synced_days(self) -> set[date]:
        """已完整下载的交易日集合。"""

        with self._db.session() as conn:
            rows = conn.execute("SELECT trade_date FROM synced_day").fetchall()
        return {d for d in (parse_date(row["trade_date"]) for row in rows) if d is not None}

    def count_synced_days(self) -> int:
        """已完整下载的交易日数量。"""

        with self._db.session() as conn:
            row = conn.execute("SELECT COUNT(*) AS n FROM synced_day").fetchone()
        return int(row["n"]) if row else 0

    def last_completed_at(self) -> datetime | None:
        """最近一次成功完成同步的时间。"""

        with self._db.session() as conn:
            row = conn.execute(
                "SELECT finished_at FROM sync_run WHERE status = ? "
                "ORDER BY finished_at DESC LIMIT 1",
                (SyncStatus.SUCCEEDED.value,),
            ).fetchone()
        return _parse_dt(row["finished_at"]) if row else None


def _pid_alive(pid: int) -> bool:
    """判断进程是否仍然存在 (跨平台)。"""

    try:
        import psutil  # type: ignore[import-not-found]

        return psutil.pid_exists(pid)
    except ImportError:
        pass

    import os

    try:
        if os.name == "nt":  # pragma: no cover - 平台相关
            import ctypes

            process = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)
            if not process:
                return False
            ctypes.windll.kernel32.CloseHandle(process)
            return True
        os.kill(pid, 0)  # pragma: no cover - 平台相关
        return True
    except OSError:
        return False


def _row_to_progress(row: sqlite3.Row) -> SyncProgress:
    started = _parse_dt(row["started_at"]) or datetime.now(UTC)
    return SyncProgress(
        run_id=row["run_id"],
        mode=SyncMode(row["mode"]),
        status=SyncStatus(row["status"]),
        phase=row["phase"],
        started_at=started,
        finished_at=_parse_dt(row["finished_at"]),
        total_stocks=int(row["total_stocks"]),
        done_stocks=int(row["done_stocks"]),
        total_days=int(row["total_days"]),
        done_days=int(row["done_days"]),
        message=row["message"],
        error=row["error"],
    )
