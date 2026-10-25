"""板块归属查询及本地缓存, 供天梯展示和后续分类共同使用。"""

import logging
from concurrent.futures import Future
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from threading import Lock

from pydantic import TypeAdapter, ValidationError

from app.core.errors import InvalidRequestError, ProviderError
from app.domain.sectors import StockSectors
from app.domain.symbols import is_a_share_code
from app.providers.base import MarketDataProvider
from app.repositories.database import Database
from app.repositories.meta_repository import MetaRepository

logger = logging.getLogger(__name__)
_PROFILE = TypeAdapter(StockSectors)


class StockSectorService:
    def __init__(self, provider: MarketDataProvider, database: Database) -> None:
        self.provider = provider
        self.database = database
        self.meta = MetaRepository(database)
        self._lock = Lock()
        self._inflight: dict[str, Future[StockSectors]] = {}

    def get(self, code: str, *, refresh: bool = False) -> StockSectors:
        if not is_a_share_code(code):
            raise InvalidRequestError("板块查询仅支持沪深 A 股。")
        with self._lock:
            key = f"stock_sectors:v1:{code}"
            raw = self.meta.get(key)
            cached = None
            if raw:
                try:
                    cached = _PROFILE.validate_json(raw)
                    if cached.code != code or cached.fetched_at.tzinfo is None:
                        cached = None
                except ValidationError:
                    logger.warning("忽略无效板块缓存: %s", code)
            if (cached and not refresh and
                    timedelta(0) <= datetime.now(UTC) - cached.fetched_at < timedelta(days=1)):
                return cached
            pending = self._inflight.get(code)
            owner = pending is None
            if owner:
                pending = Future()
                self._inflight[code] = pending
        # 同一股票合并等待, 其他股票和缓存读取不等待外部请求。
        if not owner:
            return pending.result()
        try:
            try:
                profile = self.provider.fetch_stock_sectors(code)
            except ProviderError:
                if cached is None:
                    raise
                logger.warning("板块查询失败, 返回旧缓存: %s", code)
                profile = replace(cached, stale=True)
            else:
                with self.database.session() as conn:
                    self.meta.set(conn, key, _PROFILE.dump_json(profile).decode("utf-8"))
        except BaseException as exc:
            pending.set_exception(exc)
            raise
        else:
            pending.set_result(profile)
            return profile
        finally:
            with self._lock:
                del self._inflight[code]
