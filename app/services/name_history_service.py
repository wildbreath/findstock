"""历史简称服务 (带本地缓存)。

历史简称只在 "缺少 D2 当天简称快照" 且 "股票已通过其它全部筛选条件" 时才会用到,
因此这里按需抓取 + 落库缓存, 避免为全市场 5000 多只股票各发一次请求。
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from datetime import UTC, datetime, timedelta

from app.providers.base import MarketDataProvider
from app.repositories.database import Database
from app.repositories.stock_repository import StockRepository

logger = logging.getLogger(__name__)

#: 缓存有效期: 简称变更是低频事件, 几天内不必重复抓取。
DEFAULT_TTL_DAYS = 3


class NameHistoryService:
    """提供某只股票的历史简称序列。"""

    def __init__(
        self,
        database: Database,
        stock_repository: StockRepository,
        provider_factory: Callable[[], MarketDataProvider],
        *,
        ttl_days: int = DEFAULT_TTL_DAYS,
    ) -> None:
        self._db = database
        self._stocks = stock_repository
        self._provider_factory = provider_factory
        self._ttl = timedelta(days=ttl_days)
        self._provider: MarketDataProvider | None = None

    def _resolve_provider(self) -> MarketDataProvider:
        if self._provider is None:
            self._provider = self._provider_factory()
        return self._provider

    def history_for(self, code: str) -> list[str]:
        """返回历史简称 (由旧到新); 数据源不可用时返回已缓存的内容。"""

        fetched_at = self._stocks.name_change_fetched_at(code)
        if fetched_at is not None and datetime.now(UTC) - fetched_at < self._ttl:
            return self._stocks.load_name_changes(code)

        try:
            names = self._resolve_provider().fetch_name_change_history(code)
        except Exception as exc:  # noqa: BLE001 - 抓不到就退回缓存, 不能拖垮筛选
            logger.warning("获取 %s 历史简称失败, 使用缓存: %s", code, exc)
            return self._stocks.load_name_changes(code)

        with self._db.session() as conn:
            self._stocks.save_name_changes(conn, code, names)
        return names
