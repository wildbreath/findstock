"""交易日历接口。"""

from __future__ import annotations

from datetime import date, timedelta

from fastapi import APIRouter, Depends, Query

from app.api.deps import get_container
from app.api.schemas import CalendarResponse, TradingDayOut
from app.container import Container

router = APIRouter(prefix="/calendar", tags=["交易日历"])


@router.get("", response_model=CalendarResponse, summary="查询交易日历")
def get_calendar(
    start: date | None = Query(default=None, description="起始日期"),
    end: date | None = Query(default=None, description="结束日期"),
    recent: int = Query(default=20, ge=0, le=200, description="返回最近 N 个交易日"),
    container: Container = Depends(get_container),
) -> CalendarResponse:
    """返回指定区间的交易日历, 以及最近若干个交易日。"""

    today = date.today()
    resolved_end = end or today
    resolved_start = start or (resolved_end - timedelta(days=30))

    days = container.calendar_repository.open_days(resolved_start, resolved_end)
    recent_days = container.calendar_repository.open_days_on_or_before(
        resolved_end, recent
    )
    return CalendarResponse(
        days=[TradingDayOut(trade_date=day, is_open=True) for day in days],
        recent_trading_days=recent_days,
    )
