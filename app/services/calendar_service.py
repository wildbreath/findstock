"""交易日历服务: 由用户选择的日期推导 D0 / D1 / D2。"""

from __future__ import annotations

import logging
from datetime import date

from app.core.errors import (
    CalendarNotInitializedError,
    InsufficientHistoryError,
    NotATradingDayError,
)
from app.domain.models import ScreenWindow
from app.repositories.bar_repository import BarRepository
from app.repositories.calendar_repository import CalendarRepository
from app.repositories.sync_repository import SyncRepository

logger = logging.getLogger(__name__)

#: 需要向前追溯的交易日数量: D2 / D1 / D0 / D0 之前一个交易日。
_WINDOW_LOOKBACK = 4


class TradingCalendarService:
    """按交易日历 (而非自然日) 解析筛选窗口。"""

    def __init__(
        self,
        calendar_repository: CalendarRepository,
        bar_repository: BarRepository,
        sync_repository: SyncRepository,
    ) -> None:
        self._calendar = calendar_repository
        self._bars = bar_repository
        self._sync = sync_repository

    def resolve_window(self, selected_date: date) -> ScreenWindow:
        """解析出 D0/D1/D2。

        Raises:
            CalendarNotInitializedError: 本地还没有交易日历。
            NotATradingDayError: 所选日期不是交易日。
            InsufficientHistoryError: 所选日期之前的交易日不足两个。
        """

        latest = self._calendar.latest_open_day()
        if latest is None:
            raise CalendarNotInitializedError(
                "本地尚未下载交易日历, 请先执行数据初始化。"
            )

        recent = self._calendar.open_days_on_or_before(selected_date, _WINDOW_LOOKBACK)
        if not recent or recent[0] != selected_date:
            raise NotATradingDayError(
                f"{selected_date.isoformat()} 不是交易日, 请重新选择日期。",
                selected_date=selected_date,
                suggested_date=self.latest_complete_trading_day(),
            )

        if len(recent) < 3:
            raise InsufficientHistoryError(
                f"{selected_date.isoformat()} 之前的交易日不足两个, 无法计算 D0/D1/D2。",
                selected_date=selected_date,
                available_before=len(recent) - 1,
            )

        d2, d1, d0 = recent[0], recent[1], recent[2]
        previous = recent[3] if len(recent) > 3 else None
        logger.debug("筛选窗口解析: D0=%s D1=%s D2=%s", d0, d1, d2)
        return ScreenWindow(
            selected_date=selected_date,
            d0=d0,
            d1=d1,
            d2=d2,
            previous_trading_day=previous,
        )

    def latest_complete_trading_day(self) -> date | None:
        """最近一个 "数据完整" 的交易日, 用于给出建议日期。

        优先取已完整下载的交易日, 否则退化为本地行情中最晚的一天。
        """

        synced = self._sync.synced_days()
        if synced:
            return max(synced)
        return self._bars.bounds()[1]

    def recent_open_days(self, day: date, limit: int) -> list[date]:
        """``day`` (含) 之前的最近 ``limit`` 个交易日, 由近到远。"""

        return self._calendar.open_days_on_or_before(day, max(1, limit))

    def following_open_days(self, day: date, limit: int) -> list[date]:
        """``day`` 之后的最近 ``limit`` 个交易日, 由近到远 (升序)。"""

        return self._calendar.open_days_after(day, max(1, limit))

    def open_days(self, start: date, end: date) -> list[date]:
        """区间内的交易日 (升序), 供整月扫描使用。"""

        return self._calendar.open_days(start, end)

    def is_trading_day(self, day: date) -> bool | None:
        """日期是否为交易日 (日历未覆盖时返回 None)。"""

        return self._calendar.is_trading_day(day)
