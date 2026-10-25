"""SQLite 连接管理与结构初始化。"""

from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path

SCHEMA_VERSION = 7
_SCHEMA_FILE = Path(__file__).with_name("schema.sql")


class Database:
    """轻量 SQLite 封装。

    使用 WAL 模式, 使后台同步进程写入的同时 API 进程仍可读取。
    """

    def __init__(self, path: Path) -> None:
        self._path = Path(path)

    @property
    def path(self) -> Path:
        return self._path

    def connect(self) -> sqlite3.Connection:
        """创建新连接 (调用方负责关闭)。"""

        self._path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(self._path, timeout=30.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA synchronous = NORMAL")
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA busy_timeout = 30000")
        return conn

    @contextmanager
    def session(self) -> Iterator[sqlite3.Connection]:
        """事务化连接: 正常结束提交, 异常回滚。"""

        conn = self.connect()
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def initialize(self) -> None:
        """创建表结构、执行增量迁移并记录 schema 版本 (幂等)。"""

        schema = _SCHEMA_FILE.read_text(encoding="utf-8")
        with self.session() as conn:
            conn.executescript(schema)
            self._migrate(conn)
            row = conn.execute("SELECT MAX(version) AS version FROM schema_version").fetchone()
            current = row["version"] if row and row["version"] is not None else None
            if current is None or current < SCHEMA_VERSION:
                conn.execute(
                    "INSERT INTO schema_version (version, applied_at) VALUES (?, ?)",
                    (SCHEMA_VERSION, _now_iso()),
                )

    @staticmethod
    def _migrate(conn: sqlite3.Connection) -> None:
        """按需补齐旧版本缺失的列。"""

        if not _column_exists(conn, "wudao_theme_batch", "is_final"):
            conn.execute("ALTER TABLE wudao_theme_batch ADD COLUMN is_final INTEGER NOT NULL DEFAULT 1")

        # v2: 为每只股票记录抓取进度, 使全量下载可以断点续传。
        if not _column_exists(conn, "stock", "last_sync_end"):
            conn.execute("ALTER TABLE stock ADD COLUMN last_sync_end TEXT")
        # v3: 数据源由 baostock 换成 akshare, 不再写入 daily_bar.is_st。
        # SQLite 允许保留多余的旧列, 因此旧库无需重建, 新库按新结构创建。
        # v4: 新增 watchlist (自选股) 表, 由 schema.sql 的 CREATE TABLE IF NOT EXISTS
        # 自动补齐, 旧库无需迁移数据。
        # v5: 新增 ladder_snapshot 日存档表, 同样由 schema.sql 幂等创建。
        # v6: 保留原有备注和显示顺序, 增加文字高亮与手动排序。
        if not _column_exists(conn, "watchlist", "note_highlights"):
            conn.execute(
                "ALTER TABLE watchlist ADD COLUMN note_highlights TEXT NOT NULL DEFAULT '[]'"
            )
        if not _column_exists(conn, "watchlist", "sort_order"):
            conn.execute("ALTER TABLE watchlist ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0")
            rows = conn.execute(
                "SELECT code FROM watchlist ORDER BY added_at DESC, code"
            ).fetchall()
            conn.executemany(
                "UPDATE watchlist SET sort_order = ? WHERE code = ?",
                [(index, row["code"]) for index, row in enumerate(rows)],
            )


def _column_exists(conn: sqlite3.Connection, table: str, column: str) -> bool:
    rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    return any(row["name"] == column for row in rows)


def _now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")
