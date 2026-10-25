"""测试数据构造工具。"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from app.container import Container
from app.domain.enums import Board, TradeStatus
from app.domain.models import DailyBar, StockInfo
from app.domain.symbols import detect_board, split_code


def make_bar(
    code: str,
    day: date,
    *,
    pct_chg: float | str | None = 1.0,
    volume: int | None = 1_000_000,
    close: float | None = 10.0,
    trade_status: TradeStatus | None = TradeStatus.NORMAL,
) -> DailyBar:
    """构造一根日线。"""

    return DailyBar(
        code=code,
        trade_date=day,
        close=None if close is None else Decimal(str(close)),
        open=None if close is None else Decimal(str(close)),
        high=None if close is None else Decimal(str(close)),
        low=None if close is None else Decimal(str(close)),
        preclose=None if close is None else Decimal(str(close)),
        volume=volume,
        pct_chg=None if pct_chg is None else Decimal(str(pct_chg)),
        trade_status=trade_status,
    )


def make_stock(
    code: str,
    name: str | None = "测试股份",
    *,
    listing_date: date | None = None,
    board: Board | None = None,
) -> StockInfo:
    """构造股票基础信息。"""

    exchange, symbol = split_code(code)
    return StockInfo(
        code=code,
        exchange=exchange,
        symbol=symbol,
        name=name,
        board=board or detect_board(code),
        listing_date=listing_date,
    )


def seed(
    container: Container,
    *,
    open_days: list[date],
    closed_days: list[date] | None = None,
    stocks: list[StockInfo] | None = None,
    bars: list[DailyBar] | None = None,
    names: dict[date, list[tuple[str, str]]] | None = None,
    mark_synced: bool = True,
) -> None:
    """把测试数据写入数据库。"""

    with container.database.session() as conn:
        container.calendar_repository.upsert_days(
            conn, [(day, True) for day in open_days]
        )
        container.calendar_repository.upsert_days(
            conn, [(day, False) for day in (closed_days or [])]
        )
        if stocks:
            container.stock_repository.upsert_stocks(conn, stocks)
        if names:
            for day, entries in names.items():
                container.stock_repository.upsert_name_history(
                    conn, [(code, day, name) for code, name in entries]
                )
        if bars:
            container.bar_repository.upsert_bars(conn, bars)

    if mark_synced and bars:
        counts: dict[date, int] = {}
        for bar in bars:
            counts[bar.trade_date] = counts.get(bar.trade_date, 0) + 1
        with container.database.session() as conn:
            for day, count in counts.items():
                container.sync_repository.mark_day_synced(conn, day, count)
