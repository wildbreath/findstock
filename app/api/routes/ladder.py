"""连板天梯接口。"""

from datetime import date

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field, SecretStr

from app.api.deps import get_container
from app.container import Container
from app.domain.ladder import LadderSectorCandidates, LadderSnapshot, LadderThemeCandidates

router = APIRouter(tags=["连板天梯"])


class ThemeConfigRequest(BaseModel):
    api_key: SecretStr


class ThemeSyncRequest(BaseModel):
    max_calls: int = Field(default=50, ge=1, le=50)


@router.get("/stock-ladder/themes/status", summary="本地悟道题材覆盖与本机调用额度")
def theme_status(container: Container = Depends(get_container)) -> dict:
    return container.wudao_theme_service.status()


@router.post("/stock-ladder/themes/config", summary="仅在本机保存悟道密钥，不返回密钥")
def configure_themes(payload: ThemeConfigRequest, container: Container = Depends(get_container)) -> dict:
    return container.wudao_theme_service.configure(payload.api_key.get_secret_value())


@router.post("/stock-ladder/themes/sync", status_code=202, summary="按100条分页下载全部缺失题材，达到调用上限后续传")
def sync_themes(payload: ThemeSyncRequest, container: Container = Depends(get_container)) -> dict:
    return container.wudao_theme_service.start(payload.max_calls)


@router.get("/stock-ladder/theme-candidates", response_model=LadderThemeCandidates,
            summary="指定交易日本地涨停池的悟道主类，包含全部连板高度")
def theme_candidates(
    selected_date: date | None = Query(default=None, alias="date", description="题材来源交易日，默认最新交易日"),
    container: Container = Depends(get_container),
) -> LadderThemeCandidates:
    return container.ladder_service.theme_candidates(selected_date)


@router.get("/stock-ladder/sector-candidates", response_model=LadderSectorCandidates,
            summary="最近60个交易日本地存档中出现四板及以上的股票")
def ladder_sector_candidates(container: Container = Depends(get_container)) -> LadderSectorCandidates:
    return container.ladder_service.sector_candidates()


@router.get("/stock-ladder", response_model=LadderSnapshot, summary="本地天梯；仅盘中当天允许实时涨停池")
def stock_ladder(
    selected_date: date | None = Query(default=None, alias="date", description="交易日, 默认最新交易日"),
    refresh: bool = Query(default=False, description="重新读取本地；仅交易时段当天可刷新原涨停池，悟道始终读本地"),
    container: Container = Depends(get_container),
) -> LadderSnapshot:
    return container.ladder_service.snapshot(selected_date, refresh=refresh)
