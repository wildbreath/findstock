"""交易日历仓储。"""

from __future__ import annotations

import sqlite3
from collections.abc import Iterable
from datetime import date

from app.repositories.database import Database
from app.repositories.mappers import parse_date


class CalendarRepository:
    """读写 ``trading_day`` 表。"""

    def __init__(self, database: Database) -> None:
        self._db = database

    def upsert_days(
        self, conn: sqlite3.Connection, days: Iterable[tuple[date, bool]]
    ) -> int:
        """批量写入交易/非交易标记, 返回写入行数。"""

        payload = [(day.isoformat(), 1 if is_open else 0) for day, is_open in days]
        if not payload:
            return 0
        conn.executemany(
            "INSERT INTO trading_day (trade_date, is_open) VALUES (?, ?) "
            "ON CONFLICT(trade_date) DO UPDATE SET is_open = excluded.is_open",
            payload,
        )
        return len(payload)

    def open_days(self, start: date, end: date) -> list[date]:
        """返回区间内的交易日 (升序)。"""

        with self._db.session() as conn:
            rows = conn.execute(
                "SELECT trade_date FROM trading_day "
                "WHERE is_open = 1 AND trade_date BETWEEN ? AND ? ORDER BY trade_date",
                (start.isoformat(), end.isoformat()),
            ).fetchall()
        return [d for d in (parse_date(r["trade_date"]) for r in rows) if d is not None]

    def open_days_on_or_before(self, day: date, limit: int) -> list[date]:
        """返回不晚于 ``day`` 的最近 ``limit`` 个交易日 (降序)。"""

        if limit <= 0:
            return []
        with self._db.session() as conn:
            rows = conn.execute(
                "SELECT trade_date FROM trading_day "
                "WHERE is_open = 1 AND trade_date <= ? ORDER BY trade_date DESC LIMIT ?",
                (day.isoformat(), limit),
            ).fetchall()
        return [d for d in (parse_date(r["trade_date"]) for r in rows) if d is not None]

    def open_days_after(self, day: date, limit: int) -> list[date]:
        """返回晚于 ``day`` 的最近 ``limit`` 个交易日 (升序); 用于 T+1 这类节点。"""

        if limit <= 0:
            return []
        with self._db.session() as conn:
            rows = conn.execute(
                "SELECT trade_date FROM trading_day "
                "WHERE is_open = 1 AND trade_date > ? ORDER BY trade_date ASC LIMIT ?",
                (day.isoformat(), limit),
            ).fetchall()
        return [d for d in (parse_date(r["trade_date"]) for r in rows) if d is not None]

    def latest_open_day(self) -> date | None:
        """日历中最后一个交易日。"""

        with self._db.session() as conn:
            row = conn.execute(
                "SELECT MAX(trade_date) AS day FROM trading_day WHERE is_open = 1"
            ).fetchone()
        return parse_date(row["day"]) if row else None

    def earliest_open_day(self) -> date | None:
        """日历中第一个交易日。"""

        with self._db.session() as conn:
            row = conn.execute(
                "SELECT MIN(trade_date) AS day FROM trading_day WHERE is_open = 1"
            ).fetchone()
        return parse_date(row["day"]) if row else None

    def is_trading_day(self, day: date) -> bool | None:
        """判断是否交易日; 日历中无记录时返回 None。"""

        with self._db.session() as conn:
            row = conn.execute(
                "SELECT is_open FROM trading_day WHERE trade_date = ?", (day.isoformat(),)
            ).fetchone()
        if row is None:
            return None
        return bool(row["is_open"])

    def count_open_days(self) -> int:
        """交易日总数。"""

        with self._db.session() as conn:
            row = conn.execute(
                "SELECT COUNT(*) AS n FROM trading_day WHERE is_open = 1"
            ).fetchone()
        return int(row["n"]) if row else 0
