"""数据源抽象接口。"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Protocol, runtime_checkable

from app.domain.ladder import LimitUpStock
from app.domain.models import DailyBar
from app.domain.sectors import StockSectors


@dataclass(frozen=True, slots=True)
class StockSnapshot:
    """数据源给出的某交易日证券快照。"""

    code: str
    name: str
    is_trading: bool


@runtime_checkable
class MarketDataProvider(Protocol):
    """行情数据源需实现的最小接口。

    抽象出接口的目的: 便于单元测试注入假数据源, 也便于将来更换数据源。
    """

    name: str

    def open(self) -> None:
        """建立会话 / 预热 (无状态数据源可为空实现)。"""

    def close(self) -> None:
        """释放会话 (无状态数据源可为空实现)。"""

    def fetch_trading_calendar(self, start: date, end: date) -> list[tuple[date, bool]]:
        """返回区间内每个自然日的交易标记。"""

    def fetch_stock_universe(self, day: date) -> list[StockSnapshot]:
        """返回全部沪深A股及其简称。

        注意: 数据源只能提供 **当前** 简称时, 调用方应当把快照记在
        "实际取数那一天" 上, 而不是参数 ``day`` 上。
        """

    def fetch_daily_bars(self, code: str, start: date, end: date) -> list[DailyBar]:
        """返回单只股票在区间内的日线行情。"""

    def fetch_listing_dates(self) -> dict[str, date]:
        """交易所公布的上市日期，用于区分上市前的合理缺行。"""

    def fetch_suspended_codes(self, day: date) -> set[str]:
        """指定交易日确认全天停牌的沪深 A 股代码。"""

    def fetch_delisting_dates(self) -> dict[str, date]:
        """交易所确认的终止上市日期；该日起不再要求有行情。"""

    def fetch_name_change_history(self, code: str) -> list[str]:
        """返回股票的历史简称序列 (由旧到新)。

        用于在缺少 "当日简称快照" 时推断历史 ST 状态。
        数据源不支持时返回空列表。
        """

    def fetch_limit_up_pool(self, day: date) -> list[LimitUpStock]:
        """东方财富近期涨停股池, 包含源端给出的连板数。"""

    def fetch_limit_up_pool_ths(self, day: date) -> list[LimitUpStock]:
        """同花顺历史涨停池，连续涨停数取源端连续涨停统计。"""

    def fetch_stock_sectors(self, code: str) -> StockSectors:
        """当前所属板块及源端行业层级, 不代表历史当天的归属。"""
