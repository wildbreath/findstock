"""数据源适配层。"""

from __future__ import annotations

from app.core.errors import FindStockError
from app.providers.base import MarketDataProvider, StockSnapshot

__all__ = ["MarketDataProvider", "StockSnapshot", "create_provider", "SUPPORTED_PROVIDERS"]

#: 可用的数据源实现。新增数据源时在此登记。
SUPPORTED_PROVIDERS = ("akshare",)


def create_provider(name: str, *, timeout: float = 20.0, max_attempts: int = 3):
    """按名称构造数据源。"""

    normalized = (name or "akshare").strip().lower()
    if normalized == "akshare":
        from app.providers.akshare_provider import AkshareProvider

        return AkshareProvider(timeout=timeout, max_attempts=max_attempts)
    raise FindStockError(
        f"未知的数据源 {name!r}, 目前支持: {', '.join(SUPPORTED_PROVIDERS)}"
    )
