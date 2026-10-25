"""按交易日保存完整涨停池, 不依赖本地股票名单或日线覆盖。"""

import logging
from datetime import UTC, date

from pydantic import TypeAdapter, ValidationError

from app.domain.ladder import LadderSnapshot
from app.repositories.database import Database
from app.repositories.mappers import parse_date

logger = logging.getLogger(__name__)
_SNAPSHOT = TypeAdapter(LadderSnapshot)


class LadderRepository:
    def __init__(self, database: Database) -> None:
        self.database = database

    def get(self, day: date) -> LadderSnapshot | None:
        with self.database.session() as conn:
            row = conn.execute("SELECT payload FROM ladder_snapshot WHERE trade_date = ?", (day.isoformat(),)).fetchone()
        if row is None:
            return None
        try:
            snapshot = _SNAPSHOT.validate_json(row["payload"])
            if snapshot.trade_date == day and snapshot.items and snapshot.fetched_at.tzinfo is not None:
                return snapshot
        except ValidationError:
            pass
        logger.warning("忽略无效涨停池存档: %s", day)
        return None

    def dates(self) -> list[date]:
        with self.database.session() as conn:
            rows = conn.execute("SELECT trade_date FROM ladder_snapshot ORDER BY trade_date").fetchall()
        return [day for row in rows if (day := parse_date(row["trade_date"])) is not None]

    def save(self, snapshot: LadderSnapshot) -> None:
        if not snapshot.items:
            return
        with self.database.session() as conn:
            conn.execute(
                "INSERT INTO ladder_snapshot (trade_date, fetched_at, payload) VALUES (?, ?, ?) "
                "ON CONFLICT(trade_date) DO UPDATE SET fetched_at = excluded.fetched_at, payload = excluded.payload "
                "WHERE excluded.fetched_at >= ladder_snapshot.fetched_at",
                (snapshot.trade_date.isoformat(), snapshot.fetched_at.astimezone(UTC).isoformat(), _SNAPSHOT.dump_json(snapshot).decode("utf-8")),
            )
