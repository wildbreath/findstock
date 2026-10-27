"""日线行情仓储。"""

from __future__ import annotations

import sqlite3
from collections.abc import Iterable, Sequence
from datetime import date

from app.domain.models import DailyBar
from app.repositories.database import Database
from app.repositories.mappers import parse_date, row_to_daily_bar


def _bar_payload(bar: DailyBar) -> tuple[object, ...]:
    def as_float(value: object) -> float | None:
        return None if value is None else float(value)

    return (
        bar.code,
        bar.trade_date.isoformat(),
        as_float(bar.open),
        as_float(bar.high),
        as_float(bar.low),
        as_float(bar.close),
        as_float(bar.preclose),
        bar.volume,
        as_float(bar.amount),
        None if bar.turnover is None else str(bar.turnover),
        None if bar.pct_chg is None else str(bar.pct_chg),
        None if bar.trade_status is None else int(bar.trade_status),
    )


class BarRepository:
    """读写 ``daily_bar`` 表。"""

    def __init__(self, database: Database) -> None:
        self._db = database

    def upsert_bars(
        self, conn: sqlite3.Connection, bars: Iterable[DailyBar], *, replace_price_basis: bool = False
    ) -> int:
        """批量写入日线行情, 返回写入行数。"""

        payload = [_bar_payload(bar) for bar in bars]
        if not payload:
            return 0
        conn.executemany(
            """
            INSERT INTO daily_bar (
                code, trade_date, open, high, low, close, preclose, volume,
                amount, turnover, pct_chg, trade_status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(code, trade_date) DO UPDATE SET
                open = excluded.open,
                high = excluded.high,
                low = excluded.low,
                close = excluded.close,
                preclose = excluded.preclose,
                volume = excluded.volume,
                amount = COALESCE(excluded.amount, daily_bar.amount),
                turnover = COALESCE(excluded.turnover, daily_bar.turnover),
                pct_chg = excluded.pct_chg,
                trade_status = excluded.trade_status
            """ + ("" if replace_price_basis else
                   " WHERE excluded.pct_chg IS NOT NULL OR daily_bar.pct_chg IS NULL"),
            payload,
        )
        return len(payload)

    def load_bars_for_dates(
        self, dates: Sequence[date], codes: Sequence[str] | None = None,
    ) -> dict[str, dict[date, DailyBar]]:
        """一次性取出若干交易日的全部行情, 按 (代码, 日期) 组织。"""

        if not dates or codes is not None and not codes:
            return {}
        placeholders = ",".join("?" for _ in dates)
        code_filter = " AND code IN (" + ",".join("?" for _ in codes) + ")" if codes is not None else ""
        with self._db.session() as conn:
            rows = conn.execute(
                f"SELECT * FROM daily_bar WHERE trade_date IN ({placeholders})" + code_filter,
                [d.isoformat() for d in dates] + (list(codes) if codes is not None else []),
            ).fetchall()

        result: dict[str, dict[date, DailyBar]] = {}
        for row in rows:
            bar = row_to_daily_bar(row)
            result.setdefault(bar.code, {})[bar.trade_date] = bar
        return result

    def covers_dates(self, dates: Sequence[date]) -> dict[date, int]:
        """返回每个交易日已入库的行情条数。"""

        if not dates:
            return {}
        placeholders = ",".join("?" for _ in dates)
        with self._db.session() as conn:
            rows = conn.execute(
                f"SELECT trade_date, COUNT(*) AS n FROM daily_bar "
                f"WHERE trade_date IN ({placeholders}) GROUP BY trade_date",
                [d.isoformat() for d in dates],
            ).fetchall()
        found = {parse_date(row["trade_date"]): int(row["n"]) for row in rows}
        return {day: found.get(day, 0) for day in dates}

    def count(self) -> int:
        """行情总条数。"""

        with self._db.session() as conn:
            row = conn.execute("SELECT COUNT(*) AS n FROM daily_bar").fetchone()
        return int(row["n"]) if row else 0

    def load_recent_bars(
        self, code: str, *, end: date | None = None, limit: int = 240
    ) -> list[DailyBar]:
        """取某只股票截止到 ``end`` 的最近 ``limit`` 根日线 (按日期升序返回)。"""

        if limit <= 0:
            return []
        sql = "SELECT * FROM daily_bar WHERE code = ?"
        params: list[object] = [code]
        if end is not None:
            sql += " AND trade_date <= ?"
            params.append(end.isoformat())
        sql += " ORDER BY trade_date DESC LIMIT ?"
        params.append(limit)

        with self._db.session() as conn:
            rows = conn.execute(sql, params).fetchall()
        return [row_to_daily_bar(row) for row in reversed(rows)]

    def latest_bars(self, codes: Sequence[str]) -> dict[str, DailyBar]:
        """每只股票本地最新的一根日线, 供自选股列表展示。"""

        if not codes:
            return {}
        placeholders = ",".join("?" for _ in codes)
        with self._db.session() as conn:
            rows = conn.execute(
                f"""
                SELECT b.* FROM daily_bar AS b
                JOIN (
                    SELECT code, MAX(trade_date) AS trade_date
                    FROM daily_bar
                    WHERE code IN ({placeholders})
                    GROUP BY code
                ) AS latest
                  ON latest.code = b.code AND latest.trade_date = b.trade_date
                """,
                list(codes),
            ).fetchall()
        return {row["code"]: row_to_daily_bar(row) for row in rows}

    def count_on(self, day: date) -> int:
        """某个交易日的行情条数。"""

        with self._db.session() as conn:
            row = conn.execute(
                "SELECT COUNT(*) AS n FROM daily_bar WHERE trade_date = ?",
                (day.isoformat(),),
            ).fetchone()
        return int(row["n"]) if row else 0

    def bounds(self) -> tuple[date | None, date | None]:
        """本地行情的最早/最晚交易日。"""

        with self._db.session() as conn:
            row = conn.execute(
                "SELECT MIN(trade_date) AS lo, MAX(trade_date) AS hi FROM daily_bar"
            ).fetchone()
        if row is None:
            return None, None
        return parse_date(row["lo"]), parse_date(row["hi"])

    def distinct_codes(self) -> int:
        """有行情数据的股票数。"""

        with self._db.session() as conn:
            row = conn.execute(
                "SELECT COUNT(DISTINCT code) AS n FROM daily_bar"
            ).fetchone()
        return int(row["n"]) if row else 0
