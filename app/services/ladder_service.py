"""天梯浏览只读本地；当日交易时段可实时更新，收盘数据由显式下载保存。"""

import logging
from dataclasses import replace
from datetime import date, datetime, time, timedelta, timezone

from pydantic import TypeAdapter, ValidationError

from app.core.errors import DataNotAvailableError, InvalidRequestError, ProviderError
from app.domain.ladder import (
    LadderSectorCandidates,
    LadderSnapshot,
    LadderThemeCandidates,
    ThemeCandidate,
)
from app.providers.base import MarketDataProvider
from app.providers.http_timeout import guard_requests
from app.repositories.calendar_repository import CalendarRepository
from app.repositories.database import Database
from app.repositories.ladder_repository import LadderRepository
from app.repositories.meta_repository import MetaRepository
from app.repositories.wudao_repository import WudaoRepository

MARKET_TIMEZONE = timezone(timedelta(hours=8))
HISTORY_DAYS = 365
_CALENDAR = TypeAdapter(tuple[date, list[date]])
logger = logging.getLogger(__name__)


class LadderService:
    def __init__(self, provider: MarketDataProvider, database: Database) -> None:
        self.provider = provider
        self.repository = LadderRepository(database)
        self.meta = MetaRepository(database)
        self.database = database
        self.themes = WudaoRepository(database)

    def _realtime_allowed(self, day: date) -> bool:
        now = datetime.now(MARKET_TIMEZONE)
        return (day == now.date() and CalendarRepository(self.database).is_trading_day(day) is True
                and (time(9, 15) <= now.time() < time(11, 30) or time(13) <= now.time() < time(15)))

    def _assert_realtime_allowed(self, day: date) -> None:
        if not self._realtime_allowed(day):
            raise DataNotAvailableError("已离开当天交易时段，只能读取本地天梯；缺失数据请到数据页面下载。",
                                        missing_dates=(day,), required_dates=(day,))

    def _trading_days(self, today: date, *, lookback_days: int = HISTORY_DAYS) -> list[date]:
        saved = self.repository.dates()
        cutoff = today - timedelta(days=lookback_days)
        calendar = []
        raw = self.meta.get("stock_ladder_calendar:v1")
        if raw:
            try:
                _, calendar = _CALENDAR.validate_json(raw)
            except ValidationError:
                logger.warning("忽略无效天梯交易日历缓存")
        if lookback_days > 45:
            calendar = sorted(set(calendar) | set(CalendarRepository(self.database).open_days(cutoff, today)))
        days = sorted({day for day in calendar if cutoff <= day <= today} | {day for day in saved if day <= today})
        if not days:
            raise DataNotAvailableError("本地交易日历尚未初始化，请到数据页面下载交易日历与连板天梯。")
        return days

    def sector_candidates(self) -> LadderSectorCandidates:
        today = datetime.now(MARKET_TIMEZONE).date()
        cutoff = today - timedelta(days=150)
        days = [day for day in self._trading_days(today, lookback_days=150) if cutoff <= day <= today][-60:]
        covered, codes = [], set()
        for day in days:
            snapshot = self.repository.get(day)
            if snapshot is None:
                continue
            covered.append(day)
            codes.update(item.code for item in snapshot.items if item.consecutive >= 4)
        return LadderSectorCandidates(days, covered, sorted(codes))

    def _with_themes(self, snapshot: LadderSnapshot) -> LadderSnapshot:
        themes, fetched_at, downloaded = self.themes.day(snapshot.trade_date)
        is_final = self.themes.is_final(snapshot.trade_date)
        items = [replace(item, primary_theme=themes.get(item.code)) for item in snapshot.items]
        missing = sum(not item.primary_theme for item in items)
        if not downloaded:
            error = "悟道题材分页尚未下载完整" if fetched_at else "悟道题材尚未下载"
        elif missing:
            error = f"悟道题材未匹配 {missing} 只股票"
        else:
            error = None
        return replace(
            snapshot, items=items, theme_fetched_at=fetched_at,
            theme_complete=downloaded and not missing and bool(items),
            theme_is_final=is_final, theme_error=error,
        )

    def theme_candidates(self, selected_date: date | None = None) -> LadderThemeCandidates:
        today = datetime.now(MARKET_TIMEZONE).date()
        if selected_date is not None and selected_date > today:
            raise InvalidRequestError("不能查询尚未到来的交易日。")
        days = self._trading_days(today)
        day = selected_date or days[-1]
        if day not in days:
            if CalendarRepository(self.database).is_trading_day(day) is False:
                raise InvalidRequestError("所选日期不是本地交易日历中的交易日。")
            raise DataNotAvailableError("本地没有该日交易日历或天梯，请到数据页面下载。",
                                        missing_dates=(day,), required_dates=(day,))
        covered, classified, members = [], [], {}
        unclassified = 0
        snapshot = self.repository.get(day)
        if snapshot is not None:
            snapshot = self._with_themes(snapshot)
            covered.append(day)
            if snapshot.theme_complete:
                classified.append(day)
            for item in snapshot.items:
                if item.primary_theme:
                    members.setdefault(item.primary_theme, set()).add(item.code)
                else:
                    unclassified += 1
        candidates = [ThemeCandidate(name, len(codes)) for name, codes in members.items()]
        candidates.sort(key=lambda item: (-item.stock_count, item.name))
        return LadderThemeCandidates(days, covered, classified, candidates, unclassified, day)

    def snapshot(self, selected_date: date | None = None, *, refresh: bool = False) -> LadderSnapshot:
        now = datetime.now(MARKET_TIMEZONE)
        today = now.date()
        if selected_date is not None and selected_date > today:
            raise InvalidRequestError("不能查询尚未到来的交易日。")
        days = self._trading_days(today)
        day = selected_date or days[-1]
        if day not in days:
            if CalendarRepository(self.database).is_trading_day(day) is False:
                raise InvalidRequestError("所选日期不是本地交易日历中的交易日。")
            raise DataNotAvailableError("本地没有该日交易日历或天梯，请到数据页面下载。",
                                        missing_dates=(day,), required_dates=(day,))
        cached = self.repository.get(day)
        realtime = self._realtime_allowed(day)
        fresh = cached is not None and timedelta(0) <= now - cached.fetched_at < timedelta(seconds=60)
        if not realtime or cached and (cached.is_final or not refresh and fresh):
            if cached is None:
                raise DataNotAvailableError("本地尚未下载该日连板天梯，请到数据页面下载收盘数据。",
                                            missing_dates=(day,), required_dates=(day,))
            return self._with_themes(replace(cached, trading_days=days, data_source="local", stale=False))
        try:
            with guard_requests(lambda: self._assert_realtime_allowed(day)):
                result = self._fetch_snapshot(day, days, is_final=False)
        except DataNotAvailableError:
            if cached is None:
                raise
            result = replace(cached, trading_days=days, data_source="local", stale=False)
        if not self._realtime_allowed(day):
            stored = self.repository.get(day)
            if stored is None:
                raise DataNotAvailableError("本地尚未下载该日连板天梯，请到数据页面下载收盘数据。",
                                            missing_dates=(day,), required_dates=(day,))
            result = replace(stored, trading_days=days, data_source="local", stale=result.stale)
        return self._with_themes(result)

    def download_snapshot(self, day: date) -> LadderSnapshot:
        """显式补录收盘股池；日历由同步任务预先下载到本地。"""
        now = datetime.now(MARKET_TIMEZONE)
        if day > now.date() or day == now.date() and now.time() < time(15, 30):
            raise InvalidRequestError("只能下载已经收盘的交易日天梯，当天需等到北京时间15:30。")
        if CalendarRepository(self.database).is_trading_day(day) is not True:
            raise DataNotAvailableError("本地未确认该日为交易日，请先到数据页面下载交易日历。",
                                        missing_dates=(day,), required_dates=(day,))
        if day < now.date() - timedelta(days=HISTORY_DAYS):
            raise InvalidRequestError("在线历史补录支持近一年，更早日期只能读取已有本地存档。")
        days = self._trading_days(now.date())
        return self._fetch_snapshot(day, days, is_final=True)

    def _fetch_snapshot(self, day: date, days: list[date], *, is_final: bool) -> LadderSnapshot:
        cached = self.repository.get(day)
        today = datetime.now(MARKET_TIMEZONE).date()
        try:
            origin = "eastmoney"
            items = []
            if not is_final:
                self._assert_realtime_allowed(day)
            if day >= today - timedelta(days=45):
                try:
                    items = self.provider.fetch_limit_up_pool(day)
                except ProviderError:
                    logger.warning("东方财富涨停池不可用，尝试同花顺: %s", day)
            if not items:
                if not is_final:
                    self._assert_realtime_allowed(day)
                items = self.provider.fetch_limit_up_pool_ths(day)
                origin = "ths"
        except ProviderError:
            if cached is None:
                raise
            logger.warning("涨停池更新失败, 返回本地快照: %s", day)
            return replace(cached, trading_days=days, data_source="local", stale=True)
        if not items and cached:
            logger.warning("涨停池返回为空, 保留本地快照: %s", day)
            return replace(cached, trading_days=days, data_source="local", stale=True)
        items.sort(key=lambda item: (-item.consecutive, item.first_seal or "99:99:99", item.code))
        fetched_at = datetime.now(MARKET_TIMEZONE)
        snapshot = LadderSnapshot(day, days, fetched_at, items, data_source=origin, origin=origin,
                                  is_final=is_final and bool(items))
        self.repository.save(snapshot)
        return snapshot
