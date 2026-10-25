"""悟道按日题材的本地读取；分页未完成时仍明确保留不完整状态。"""

from datetime import date, datetime

from app.repositories.database import Database


class WudaoRepository:
    def __init__(self, database: Database) -> None:
        self.database = database

    def day(self, day: date) -> tuple[dict[str, str | None], datetime | None, bool]:
        with self.database.session() as conn:
            rows = conn.execute(
                "SELECT r.code, r.primary_theme, r.fetched_at FROM wudao_theme_row r "
                "JOIN wudao_theme_batch b ON b.id = r.batch_id WHERE r.trade_date = ? "
                "AND b.status IN ('pending', 'complete') AND b.is_final=1 "
                "ORDER BY (b.status = 'complete'), r.fetched_at, b.id",
                (day.isoformat(),),
            ).fetchall()
            complete = conn.execute(
                "SELECT 1 FROM wudao_theme_batch b JOIN wudao_theme_row r ON r.batch_id=b.id "
                "WHERE b.status='complete' AND b.is_final=1 AND r.trade_date=? LIMIT 1",
                (day.isoformat(),),
            ).fetchone() is not None
        themes = {row["code"]: row["primary_theme"] for row in rows}
        fetched_at = max((datetime.fromisoformat(row["fetched_at"]) for row in rows), default=None)
        return themes, fetched_at, complete

    def is_final(self, day: date) -> bool:
        with self.database.session() as conn:
            return conn.execute(
                "SELECT 1 FROM wudao_theme_batch b JOIN wudao_theme_row r ON r.batch_id=b.id "
                "WHERE b.status='complete' AND b.is_final=1 AND r.trade_date=? LIMIT 1",
                (day.isoformat(),),
            ).fetchone() is not None
