"""手工复盘表, 复用 meta 存储并拒绝覆盖其他页面的新版本。"""

import json

from app.repositories.database import Database
from app.repositories.meta_repository import MetaRepository

_KEY = "review_sheet:v1"


class ReviewRepository:
    def __init__(self, database: Database) -> None:
        self._db = database

    def get(self) -> dict:
        raw = MetaRepository(self._db).get(_KEY)
        return json.loads(raw) if raw else {"revision": 0, "dates": [], "hidden_dates": [], "rows": []}

    def save(self, sheet: dict) -> dict | None:
        with self._db.session() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute("SELECT value FROM meta WHERE key = ?", (_KEY,)).fetchone()
            revision = json.loads(row["value"])["revision"] if row else 0
            if sheet["revision"] != revision:
                return None
            saved = {**sheet, "revision": revision + 1}
            MetaRepository(self._db).set(conn, _KEY, json.dumps(saved, ensure_ascii=False))
        return saved
