"""通用键值元数据仓储。"""

from __future__ import annotations

import sqlite3
from datetime import UTC, datetime

from app.repositories.database import Database


class MetaRepository:
    """读写 ``meta`` 表。"""

    def __init__(self, database: Database) -> None:
        self._db = database

    def set(self, conn: sqlite3.Connection, key: str, value: str) -> None:
        """写入键值。"""

        conn.execute(
            "INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value, "
            "updated_at = excluded.updated_at",
            (key, value, datetime.now(UTC).isoformat(timespec="seconds")),
        )

    def get(self, key: str) -> str | None:
        """读取键值。"""

        with self._db.session() as conn:
            row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else None
