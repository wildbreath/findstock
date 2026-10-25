"""路由聚合。"""

from __future__ import annotations

from fastapi import APIRouter

from app.api.routes import calendar, data, health, ladder, review, screen, stocks, strategies, watchlist

api_router = APIRouter()
api_router.include_router(health.router)
api_router.include_router(calendar.router)
api_router.include_router(data.router)
api_router.include_router(screen.router)
api_router.include_router(stocks.router)
api_router.include_router(watchlist.router)
api_router.include_router(strategies.router)
api_router.include_router(ladder.router)
api_router.include_router(review.router)

__all__ = ["api_router"]
