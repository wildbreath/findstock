"""股票基础信息仓储。"""

from __future__ import annotations

import sqlite3
from collections.abc import Iterable, Mapping, Sequence
from datetime import UTC, date, datetime

from app.domain.models import StockInfo
from app.repositories.database import Database
from app.repositories.mappers import parse_date, row_to_stock_info


def _now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


class StockRepository:
    """读写 ``stock`` 与 ``stock_name_history`` 表。"""

    def __init__(self, database: Database) -> None:
        self._db = database

    def upsert_stocks(
        self, conn: sqlite3.Connection, stocks: Iterable[StockInfo]
    ) -> int:
        """写入/更新股票基础信息 (已存在的推导字段不会被空值覆盖)。"""

        now = _now_iso()
        payload = [
            (
                stock.code,
                stock.exchange.value,
                stock.symbol,
                stock.name,
                stock.board.value,
                stock.ipo_date.isoformat() if stock.ipo_date else None,
                stock.out_date.isoformat() if stock.out_date else None,
                stock.listing_date.isoformat() if stock.listing_date else None,
                1 if stock.is_active else 0,
                now,
            )
            for stock in stocks
        ]
        if not payload:
            return 0
        conn.executemany(
            """
            INSERT INTO stock (
                code, exchange, symbol, name, board, ipo_date, out_date,
                listing_date, is_active, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(code) DO UPDATE SET
                name = COALESCE(excluded.name, stock.name),
                board = excluded.board,
                ipo_date = COALESCE(excluded.ipo_date, stock.ipo_date),
                out_date = COALESCE(excluded.out_date, stock.out_date),
                listing_date = COALESCE(excluded.listing_date, stock.listing_date),
                is_active = CASE WHEN COALESCE(excluded.out_date, stock.out_date) IS NULL
                                 THEN excluded.is_active ELSE 0 END,
                updated_at = excluded.updated_at
            """,
            payload,
        )
        return len(payload)

    def upsert_name_history(
        self,
        conn: sqlite3.Connection,
        entries: Iterable[tuple[str, date, str]],
    ) -> int:
        """写入某个交易日的股票简称。"""

        payload = [(code, day.isoformat(), name) for code, day, name in entries]
        if not payload:
            return 0
        conn.executemany(
            "INSERT INTO stock_name_history (code, trade_date, name) VALUES (?, ?, ?) "
            "ON CONFLICT(code, trade_date) DO UPDATE SET name = excluded.name",
            payload,
        )
        return len(payload)

    def list_all(self) -> dict[str, StockInfo]:
        """返回全部股票, 以代码为键。"""

        with self._db.session() as conn:
            rows = conn.execute("SELECT * FROM stock ORDER BY code").fetchall()
        return {row["code"]: row_to_stock_info(row) for row in rows}

    def get(self, code: str) -> StockInfo | None:
        """按代码读取一只股票。"""

        with self._db.session() as conn:
            row = conn.execute("SELECT * FROM stock WHERE code = ?", (code,)).fetchone()
        return row_to_stock_info(row) if row is not None else None

    def search(self, query: str, *, limit: int = 20) -> list[StockInfo]:
        """按名称或代码搜索全市场本地目录, 优先精确匹配。"""

        term = query.strip().lower()
        if not term:
            return []
        with self._db.session() as conn:
            rows = conn.execute(
                "SELECT * FROM stock WHERE instr(lower(code), ?) > 0 "
                "OR instr(lower(COALESCE(name, '')), ?) > 0 "
                "ORDER BY CASE WHEN code = ? OR symbol = ? OR name = ? "
                "THEN 0 ELSE 1 END, code LIMIT ?",
                (term, term, term, term, term, max(1, min(limit, 50))),
            ).fetchall()
        return [row_to_stock_info(row) for row in rows]

    def codes(self) -> list[str]:
        """返回全部股票代码。"""

        with self._db.session() as conn:
            rows = conn.execute("SELECT code FROM stock ORDER BY code").fetchall()
        return [row["code"] for row in rows]

    def count(self) -> int:
        """股票总数。"""

        with self._db.session() as conn:
            row = conn.execute("SELECT COUNT(*) AS n FROM stock").fetchone()
        return int(row["n"]) if row else 0

    def names_on(self, day: date) -> dict[str, str]:
        """返回某个交易日的全部股票简称。"""

        with self._db.session() as conn:
            rows = conn.execute(
                "SELECT code, name FROM stock_name_history WHERE trade_date = ?",
                (day.isoformat(),),
            ).fetchall()
        return {row["code"]: row["name"] for row in rows}

    def has_names_on(self, day: date) -> bool:
        """某个交易日是否已经记录过股票简称快照。"""

        with self._db.session() as conn:
            row = conn.execute(
                "SELECT 1 FROM stock_name_history WHERE trade_date = ? LIMIT 1",
                (day.isoformat(),),
            ).fetchone()
        return row is not None

    # --- 历史简称 ---------------------------------------------------------

    def load_name_changes(self, code: str) -> list[str]:
        """读取缓存的历史简称序列 (由旧到新)。"""

        with self._db.session() as conn:
            rows = conn.execute(
                "SELECT name FROM stock_name_change WHERE code = ? ORDER BY seq",
                (code,),
            ).fetchall()
        return [row["name"] for row in rows]

    def name_change_fetched_at(self, code: str) -> datetime | None:
        """读取历史简称的抓取时间; 从未抓取过返回 None。"""

        with self._db.session() as conn:
            row = conn.execute(
                "SELECT fetched_at FROM stock_name_change_fetch WHERE code = ?",
                (code,),
            ).fetchone()
        if row is None:
            return None
        try:
            return datetime.fromisoformat(row["fetched_at"])
        except ValueError:
            return None

    def save_name_changes(
        self,
        conn: sqlite3.Connection,
        code: str,
        names: Sequence[str],
        *,
        fetched_at: datetime | None = None,
    ) -> None:
        """写入历史简称 (覆盖旧值), 并记录抓取时间。"""

        timestamp = (fetched_at or datetime.now(UTC)).isoformat(timespec="seconds")
        conn.execute("DELETE FROM stock_name_change WHERE code = ?", (code,))
        if names:
            conn.executemany(
                "INSERT INTO stock_name_change (code, seq, name) VALUES (?, ?, ?)",
                [(code, index, name) for index, name in enumerate(names)],
            )
        conn.execute(
            "INSERT INTO stock_name_change_fetch (code, fetched_at, entry_count) "
            "VALUES (?, ?, ?) ON CONFLICT(code) DO UPDATE SET "
            "fetched_at = excluded.fetched_at, entry_count = excluded.entry_count",
            (code, timestamp, len(names)),
        )

    def first_bar_dates(self, codes: Sequence[str] | None = None) -> dict[str, date]:
        """返回每只股票在本地的第一根K线日期。"""

        sql = "SELECT code, MIN(trade_date) AS first_day FROM daily_bar"
        params: list[object] = []
        if codes:
            placeholders = ",".join("?" for _ in codes)
            sql += f" WHERE code IN ({placeholders})"
            params.extend(codes)
        sql += " GROUP BY code"
        with self._db.session() as conn:
            rows = conn.execute(sql, params).fetchall()
        return {
            row["code"]: parsed
            for row in rows
            if (parsed := parse_date(row["first_day"])) is not None
        }

    def refresh_derived_listing_dates(self, conn: sqlite3.Connection) -> int:
        """依据本地最早K线推算 listing_date / first_bar_date。

        本地最早K线是上市日的可靠下界: 对窗口内上市的新股它等于真实上市日,
        对更早上市的老股它不晚于窗口起点。两种情况都足以判断
        "该股在 D0 之前是否已有交易记录", 即是否满足 "上市满三个交易日"。

        ``ipo_date`` 已知时优先使用 (由 :meth:`apply_ipo_dates` 覆盖)。
        """

        cursor = conn.execute(
            """
            UPDATE stock
            SET first_bar_date = (
                    SELECT MIN(b.trade_date) FROM daily_bar AS b
                    WHERE b.code = stock.code
                ),
                listing_date = COALESCE(
                    ipo_date,
                    (
                        SELECT MIN(b.trade_date) FROM daily_bar AS b
                        WHERE b.code = stock.code
                    )
                ),
                updated_at = ?
            WHERE EXISTS (
                SELECT 1 FROM daily_bar AS b WHERE b.code = stock.code
            )
            """,
            (_now_iso(),),
        )
        return cursor.rowcount or 0

    def codes_needing_sync(self, fetch_end: date) -> list[str]:
        """返回尚未同步到 ``fetch_end`` 的股票代码。

        用于全量下载的断点续传: 已经抓到 ``fetch_end`` 的股票不会再重复下载。
        """

        with self._db.session() as conn:
            rows = conn.execute(
                "SELECT code FROM stock "
                "WHERE last_sync_end IS NULL OR last_sync_end < ? "
                "ORDER BY code",
                (fetch_end.isoformat(),),
            ).fetchall()
        return [row["code"] for row in rows]

    def mark_codes_synced(
        self, conn: sqlite3.Connection, codes: Iterable[str], fetch_end: date
    ) -> int:
        """记录这些股票已经抓取到 ``fetch_end`` (只前进, 不回退)。"""

        target = fetch_end.isoformat()
        payload = [(target, code, target) for code in codes]
        if not payload:
            return 0
        conn.executemany(
            "UPDATE stock SET last_sync_end = ? "
            "WHERE code = ? AND (last_sync_end IS NULL OR last_sync_end < ?)",
            payload,
        )
        return len(payload)

    def apply_ipo_dates(
        self, conn: sqlite3.Connection, ipo_dates: Mapping[str, date]
    ) -> int:
        """用官方上市日期覆盖推导值。"""

        if not ipo_dates:
            return 0
        payload = [
            (day.isoformat(), code, _now_iso()) for code, day in ipo_dates.items()
        ]
        conn.executemany(
            "UPDATE stock SET ipo_date = ?, listing_date = ?, updated_at = ? "
            "WHERE code = ?",
            [(day, day, ts, code) for day, code, ts in payload],
        )
        return len(payload)

    def apply_delisting_dates(
        self, conn: sqlite3.Connection, dates: Mapping[str, date]
    ) -> None:
        conn.executemany(
            "UPDATE stock SET out_date = ?, is_active = 0, updated_at = ? WHERE code = ?",
            [(day.isoformat(), _now_iso(), code) for code, day in dates.items()],
        )
