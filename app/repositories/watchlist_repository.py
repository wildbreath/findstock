"""自选股仓储。"""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from datetime import UTC, date, datetime

from app.core.errors import InvalidRequestError
from app.repositories.database import Database
from app.repositories.mappers import parse_date


@dataclass(frozen=True, slots=True)
class WatchlistItem:
    """自选股条目。"""

    code: str
    name: str | None = None
    board: str | None = None
    source_date: date | None = None
    note: str | None = None
    added_at: datetime | None = None
    #: 所属分类 id 列表 (同一只股票可以属于多个分类)。
    category_ids: tuple[int, ...] = ()
    note_highlights: tuple[tuple[int, int], ...] = ()


@dataclass(frozen=True, slots=True)
class WatchlistCategory:
    """自选股分类。"""

    id: int
    name: str
    created_at: datetime | None = None
    #: 该分类下的股票数量。
    count: int = 0


def _now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def _row_to_item(row: object) -> WatchlistItem:
    highlights = json.loads(row["note_highlights"])  # type: ignore[index]
    return WatchlistItem(
        code=str(row["code"]),  # type: ignore[index]
        name=row["name"],  # type: ignore[index]
        board=row["board"],  # type: ignore[index]
        source_date=parse_date(row["source_date"]),  # type: ignore[index]
        note=row["note"],  # type: ignore[index]
        note_highlights=tuple(tuple(value) for value in highlights),
        added_at=_parse_datetime(row["added_at"]),  # type: ignore[index]
    )


def _row_to_category(row: object) -> WatchlistCategory:
    keys = set(row.keys())  # type: ignore[union-attr]
    return WatchlistCategory(
        id=int(row["id"]),  # type: ignore[index]
        name=str(row["name"]),  # type: ignore[index]
        created_at=_parse_datetime(row["created_at"]),  # type: ignore[index]
        count=int(row["count"]) if "count" in keys else 0,  # type: ignore[index]
    )


def _parse_datetime(value: object) -> datetime | None:
    if value is None or value == "":
        return None
    try:
        return datetime.fromisoformat(str(value))
    except ValueError:
        return None


class WatchlistRepository:
    """读写 ``watchlist`` 表。"""

    def __init__(self, database: Database) -> None:
        self._db = database

    def list_all(self) -> list[WatchlistItem]:
        """按用户保存的顺序列出自选股。"""

        with self._db.session() as conn:
            rows = conn.execute(
                "SELECT code, name, board, source_date, note, note_highlights, added_at "
                "FROM watchlist ORDER BY sort_order, added_at DESC, code"
            ).fetchall()
        return [_row_to_item(row) for row in rows]

    def codes(self) -> set[str]:
        """已收藏的股票代码集合。"""

        with self._db.session() as conn:
            rows = conn.execute("SELECT code FROM watchlist").fetchall()
        return {str(row["code"]) for row in rows}

    def contains(self, code: str) -> bool:
        with self._db.session() as conn:
            row = conn.execute(
                "SELECT 1 AS ok FROM watchlist WHERE code = ?", (code,)
            ).fetchone()
        return row is not None

    def add(
        self, item: WatchlistItem, *, category_ids: list[int] | None = None
    ) -> WatchlistItem:
        """加入自选股 (重复收藏视为更新名称等信息, 不会产生重复记录)。"""

        with self._db.session() as conn:
            self._add(conn, item)
            if category_ids is not None:
                self._set_categories(conn, item.code, category_ids)
        return self.get(item.code) or item

    def add_many(
        self, items: list[WatchlistItem], *, category_ids: list[int] | None = None,
        replace_categories: bool = False,
    ) -> None:
        """整批写入或回滚；追加分类保留原分类，重复加入保留备注和排序。"""

        with self._db.session() as conn:
            conn.execute("BEGIN IMMEDIATE")
            if category_ids is not None:
                valid = {int(row["id"]) for row in conn.execute("SELECT id FROM watchlist_category")}
                if set(category_ids) - valid:
                    raise InvalidRequestError("所选分类已不存在，请重新读取分类后重试。")
            # 倒序插到顶部，让新增股票保持界面里的勾选顺序。
            for item in reversed(items):
                self._add(conn, item)
                if category_ids is not None:
                    if replace_categories:
                        self._set_categories(conn, item.code, category_ids)
                    else:
                        conn.executemany(
                            "INSERT OR IGNORE INTO watchlist_member (code, category_id, added_at) "
                            "VALUES (?, ?, ?)",
                            [(item.code, category_id, _now_iso()) for category_id in set(category_ids)],
                        )

    @staticmethod
    def _add(conn: sqlite3.Connection, item: WatchlistItem) -> None:
        added_at = (item.added_at or datetime.now(UTC)).isoformat(timespec="seconds")
        conn.execute(
            """
            INSERT INTO watchlist (
                code, name, board, source_date, note, note_highlights, added_at, sort_order
            )
            VALUES (?, ?, ?, ?, ?, ?, ?,
                    (SELECT COALESCE(MIN(sort_order), 1) - 1 FROM watchlist))
            ON CONFLICT(code) DO UPDATE SET
                name = COALESCE(excluded.name, watchlist.name),
                board = COALESCE(excluded.board, watchlist.board),
                source_date = COALESCE(excluded.source_date, watchlist.source_date),
                note = COALESCE(watchlist.note, excluded.note)
            """,
            (
                item.code,
                item.name,
                item.board,
                None if item.source_date is None else item.source_date.isoformat(),
                item.note,
                json.dumps(item.note_highlights),
                added_at,
            ),
        )

    def remove(self, code: str) -> bool:
        """移除自选股, 返回是否真的删掉了记录。"""

        with self._db.session() as conn:
            cursor = conn.execute("DELETE FROM watchlist WHERE code = ?", (code,))
        return (cursor.rowcount or 0) > 0

    def get(self, code: str) -> WatchlistItem | None:
        with self._db.session() as conn:
            row = conn.execute(
                "SELECT code, name, board, source_date, note, note_highlights, added_at "
                "FROM watchlist WHERE code = ?",
                (code,),
            ).fetchone()
        return _row_to_item(row) if row is not None else None

    def count(self) -> int:
        with self._db.session() as conn:
            row = conn.execute("SELECT COUNT(*) AS n FROM watchlist").fetchone()
        return int(row["n"]) if row else 0

    # --- 备注 -------------------------------------------------------------

    def update_note(
        self, code: str, note: str | None, *, note_highlights: tuple[tuple[int, int], ...] = ()
    ) -> bool:
        """更新某只自选股的备注, 返回是否命中记录。"""

        with self._db.session() as conn:
            cursor = conn.execute(
                "UPDATE watchlist SET note = ?, note_highlights = ? WHERE code = ?",
                (note, json.dumps(note_highlights), code),
            )
        return (cursor.rowcount or 0) > 0

    def reorder(self, codes: list[str]) -> list[str]:
        """原子保存完整顺序; 过期或重复的列表不能覆盖现有顺序。"""

        with self._db.session() as conn:
            conn.execute("BEGIN IMMEDIATE")
            current = {str(row["code"]) for row in conn.execute("SELECT code FROM watchlist")}
            if len(codes) != len(set(codes)) or set(codes) != current:
                raise InvalidRequestError("排序必须包含每只自选股且不能重复, 请刷新后重试。")
            conn.executemany(
                "UPDATE watchlist SET sort_order = ? WHERE code = ?",
                list(enumerate(codes)),
            )
        return codes

    # --- 分类 -------------------------------------------------------------

    def list_categories(self) -> list[WatchlistCategory]:
        """列出全部分类 (按名称排序), 并带上每个分类的股票数量。"""

        with self._db.session() as conn:
            rows = conn.execute(
                """
                SELECT c.id, c.name, c.created_at,
                       (SELECT COUNT(*) FROM watchlist_member AS m
                         WHERE m.category_id = c.id) AS count
                FROM watchlist_category AS c
                ORDER BY c.name
                """
            ).fetchall()
        return [_row_to_category(row) for row in rows]

    def create_category(self, name: str) -> WatchlistCategory:
        """新建分类; 同名分类直接返回已有的那条 (幂等)。"""

        cleaned = name.strip()
        if not cleaned:
            raise ValueError("分类名称不能为空")
        with self._db.session() as conn:
            conn.execute(
                "INSERT INTO watchlist_category (name, created_at) VALUES (?, ?) "
                "ON CONFLICT(name) DO NOTHING",
                (cleaned, _now_iso()),
            )
            row = conn.execute(
                "SELECT c.id, c.name, c.created_at, "
                "(SELECT COUNT(*) FROM watchlist_member AS m "
                " WHERE m.category_id = c.id) AS count "
                "FROM watchlist_category AS c WHERE c.name = ?",
                (cleaned,),
            ).fetchone()
        if row is None:  # pragma: no cover - 防御性
            raise RuntimeError("分类创建失败")
        return _row_to_category(row)

    def delete_category(self, category_id: int) -> bool:
        """删除分类 (分类与股票的关联会一并删除, 股票本身保留)。"""

        with self._db.session() as conn:
            cursor = conn.execute(
                "DELETE FROM watchlist_category WHERE id = ?", (category_id,)
            )
        return (cursor.rowcount or 0) > 0

    def categories_by_code(self) -> dict[str, list[int]]:
        """每只自选股所属的分类 id 列表。"""

        with self._db.session() as conn:
            rows = conn.execute(
                "SELECT code, category_id FROM watchlist_member ORDER BY category_id"
            ).fetchall()
        result: dict[str, list[int]] = {}
        for row in rows:
            result.setdefault(str(row["code"]), []).append(int(row["category_id"]))
        return result

    def set_categories(self, code: str, category_ids: list[int]) -> None:
        """整组替换某只股票的分类 (多对多)。"""

        with self._db.session() as conn:
            self._set_categories(conn, code, category_ids)

    @staticmethod
    def _set_categories(
        conn: sqlite3.Connection, code: str, category_ids: list[int]
    ) -> None:
        unique_ids = sorted({int(value) for value in category_ids})
        conn.execute("DELETE FROM watchlist_member WHERE code = ?", (code,))
        if unique_ids:
            placeholders = ",".join("?" for _ in unique_ids)
            valid = conn.execute(
                f"SELECT id FROM watchlist_category WHERE id IN ({placeholders})",
                unique_ids,
            ).fetchall()
            conn.executemany(
                "INSERT INTO watchlist_member (code, category_id, added_at) "
                "VALUES (?, ?, ?)",
                [(code, int(row["id"]), _now_iso()) for row in valid],
            )

    def category_ids_for(self, code: str) -> list[int]:
        with self._db.session() as conn:
            rows = conn.execute(
                "SELECT category_id FROM watchlist_member WHERE code = ? "
                "ORDER BY category_id",
                (code,),
            ).fetchall()
        return [int(row["category_id"]) for row in rows]


__all__ = ["WatchlistItem", "WatchlistRepository", "_now_iso"]
