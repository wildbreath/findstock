"""依赖装配 (composition root)。

集中构造仓储与服务, 避免各处重复 new, 也方便测试时替换实现。
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from functools import cached_property

from app.core.config import Settings, get_settings
from app.providers import create_provider
from app.providers.base import MarketDataProvider
from app.repositories.bar_repository import BarRepository
from app.repositories.calendar_repository import CalendarRepository
from app.repositories.database import Database
from app.repositories.meta_repository import MetaRepository
from app.repositories.review_repository import ReviewRepository
from app.repositories.stock_repository import StockRepository
from app.repositories.strategy_repository import StrategyRepository
from app.repositories.sync_repository import SyncRepository
from app.repositories.watchlist_repository import WatchlistRepository
from app.services.calendar_service import TradingCalendarService
from app.services.data_sync_service import DataSyncService
from app.services.ladder_service import LadderService
from app.services.name_history_service import NameHistoryService
from app.services.review_collection_service import ReviewCollectionService
from app.services.screener_service import ScreenerService
from app.services.stock_chart_service import StockChartService
from app.services.stock_sector_service import StockSectorService
from app.services.wudao_theme_service import WudaoThemeService


@dataclass
class Container:
    """应用级依赖容器。"""

    settings: Settings
    database: Database

    @classmethod
    def build(cls, settings: Settings | None = None, *, initialize: bool = True) -> Container:
        """按配置构建容器, 并按需初始化数据库结构。"""

        resolved = settings or get_settings()
        resolved.ensure_directories()
        database = Database(resolved.database_path)
        if initialize:
            database.initialize()
        return cls(settings=resolved, database=database)

    # --- 仓储 -------------------------------------------------------------

    @cached_property
    def calendar_repository(self) -> CalendarRepository:
        return CalendarRepository(self.database)

    @cached_property
    def stock_repository(self) -> StockRepository:
        return StockRepository(self.database)

    @cached_property
    def bar_repository(self) -> BarRepository:
        return BarRepository(self.database)

    @cached_property
    def sync_repository(self) -> SyncRepository:
        return SyncRepository(self.database)

    @cached_property
    def meta_repository(self) -> MetaRepository:
        return MetaRepository(self.database)

    @cached_property
    def review_repository(self) -> ReviewRepository:
        return ReviewRepository(self.database)

    @cached_property
    def watchlist_repository(self) -> WatchlistRepository:
        return WatchlistRepository(self.database)

    @cached_property
    def strategy_repository(self) -> StrategyRepository:
        return StrategyRepository(self.database)

    # --- 服务 -------------------------------------------------------------

    @cached_property
    def review_collection_service(self) -> ReviewCollectionService:
        return ReviewCollectionService(self.database)

    @cached_property
    def ladder_service(self) -> LadderService:
        return LadderService(self.provider_factory(), self.database)

    @cached_property
    def stock_sector_service(self) -> StockSectorService:
        return StockSectorService(self.provider_factory(), self.database)

    @cached_property
    def wudao_theme_service(self) -> WudaoThemeService:
        return WudaoThemeService(self.settings, self.database)

    @cached_property
    def calendar_service(self) -> TradingCalendarService:
        return TradingCalendarService(
            self.calendar_repository, self.bar_repository, self.sync_repository
        )

    @cached_property
    def provider_factory(self) -> Callable[[], MarketDataProvider]:
        """返回数据源工厂 (每次调用创建新实例, 便于并发场景隔离)。"""

        return lambda: create_provider(
            self.settings.provider,
            timeout=self.settings.request_timeout,
            max_attempts=self.settings.request_retries,
        )

    @cached_property
    def name_history_service(self) -> NameHistoryService:
        return NameHistoryService(
            self.database, self.stock_repository, self.provider_factory
        )

    @cached_property
    def screener_service(self) -> ScreenerService:
        return ScreenerService(
            self.calendar_service,
            self.bar_repository,
            self.stock_repository,
            self.sync_repository,
            self.name_history_service,
        )

    @cached_property
    def data_sync_service(self) -> DataSyncService:
        return DataSyncService(
            self.settings,
            self.database,
            calendar_repository=self.calendar_repository,
            stock_repository=self.stock_repository,
            bar_repository=self.bar_repository,
            sync_repository=self.sync_repository,
            meta_repository=self.meta_repository,
        )

    @cached_property
    def stock_chart_service(self) -> StockChartService:
        return StockChartService(
            self.bar_repository,
            self.stock_repository,
            self.watchlist_repository,
        )
