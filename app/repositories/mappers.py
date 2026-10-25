"""数据库行与领域对象之间的转换。"""

from __future__ import annotations

from datetime import date
from decimal import Decimal, InvalidOperation
from sqlite3 import Row

from app.domain.enums import Board, Exchange, TradeStatus
from app.domain.models import DailyBar, StockInfo


def parse_date(value: object) -> date | None:
    """把数据库中的 ISO 文本解析为 date。"""

    if value is None or value == "":
        return None
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value))
    except ValueError:
        return None


def parse_decimal(value: object) -> Decimal | None:
    """把文本/数值解析为 Decimal。"""

    if value is None or value == "":
        return None
    try:
        return Decimal(str(value))
    except InvalidOperation:
        return None


def parse_int(value: object) -> int | None:
    """解析整数, 空字符串视为缺失。"""

    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def parse_bool(value: object) -> bool | None:
    """解析 0/1 布尔标记, 空值视为未知。"""

    parsed = parse_int(value)
    if parsed is None:
        return None
    return parsed == 1


def parse_trade_status(value: object) -> TradeStatus | None:
    """解析交易状态。"""

    parsed = parse_int(value)
    if parsed is None:
        return None
    try:
        return TradeStatus(parsed)
    except ValueError:
        return None


def parse_board(value: object) -> Board:
    """解析板块。"""

    if value is None:
        return Board.UNKNOWN
    try:
        return Board(str(value))
    except ValueError:
        return Board.UNKNOWN


def parse_exchange(value: object) -> Exchange:
    """解析交易所。"""

    try:
        return Exchange(str(value))
    except ValueError:
        return Exchange.SH


def row_to_daily_bar(row: Row) -> DailyBar:
    """行情行 -> DailyBar。"""

    return DailyBar(
        code=row["code"],
        trade_date=parse_date(row["trade_date"]),  # type: ignore[arg-type]
        open=parse_decimal(row["open"]),
        high=parse_decimal(row["high"]),
        low=parse_decimal(row["low"]),
        close=parse_decimal(row["close"]),
        preclose=parse_decimal(row["preclose"]),
        volume=parse_int(row["volume"]),
        amount=parse_decimal(row["amount"]),
        turnover=parse_decimal(row["turnover"]),
        pct_chg=parse_decimal(row["pct_chg"]),
        trade_status=parse_trade_status(row["trade_status"]),
    )


def row_to_stock_info(row: Row) -> StockInfo:
    """股票行 -> StockInfo。"""

    return StockInfo(
        code=row["code"],
        exchange=parse_exchange(row["exchange"]),
        symbol=row["symbol"],
        name=row["name"],
        board=parse_board(row["board"]),
        ipo_date=parse_date(row["ipo_date"]),
        out_date=parse_date(row["out_date"]),
        listing_date=parse_date(row["listing_date"]),
        is_active=parse_bool(row["is_active"]) is not False,
    )
