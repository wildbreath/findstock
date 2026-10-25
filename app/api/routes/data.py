"""本地数据管理与同步接口。"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query, status

from app.api.deps import get_container
from app.api.presenters import to_sync_progress
from app.api.schemas import (
    CoverageResponse,
    EnsureCalendarRequest,
    EnsureCalendarResponse,
    StartSyncRequest,
    SyncProgressResponse,
)
from app.container import Container
from app.core.errors import InvalidRequestError
from app.domain.enums import SyncMode

router = APIRouter(prefix="/data", tags=["数据管理"])


@router.get("/coverage", response_model=CoverageResponse, summary="本地数据覆盖情况")
def get_coverage(container: Container = Depends(get_container)) -> CoverageResponse:
    """返回交易日历与行情数据的覆盖范围。"""

    coverage = container.data_sync_service.coverage()
    return CoverageResponse(
        calendar_start=coverage.calendar_start,
        calendar_end=coverage.calendar_end,
        trading_days=coverage.trading_days,
        bar_start=coverage.bar_start,
        bar_end=coverage.bar_end,
        bar_count=coverage.bar_count,
        stock_count=coverage.stock_count,
        complete_days=coverage.complete_days,
        last_sync_at=coverage.last_sync_at,
        history_years=container.settings.history_years,
    )


@router.post(
    "/calendar",
    response_model=EnsureCalendarResponse,
    summary="下载/校验交易日历",
)
def ensure_calendar(
    payload: EnsureCalendarRequest,
    container: Container = Depends(get_container),
) -> EnsureCalendarResponse:
    """交易日历为空时联网下载 (幂等)。"""

    trading_days = container.data_sync_service.ensure_calendar(years=payload.years)
    return EnsureCalendarResponse(trading_days=trading_days)


@router.post(
    "/sync",
    response_model=SyncProgressResponse,
    status_code=status.HTTP_202_ACCEPTED,
    summary="启动数据同步任务",
)
def start_sync(
    payload: StartSyncRequest,
    container: Container = Depends(get_container),
) -> SyncProgressResponse:
    """启动后台数据同步 (full / incremental / targeted)。"""

    mode = SyncMode(payload.mode)
    if mode is SyncMode.TARGETED and not payload.dates:
        raise InvalidRequestError(
            "targeted 模式需要提供 dates (需要下载的交易日列表)。"
        )
    # 同步冲突 (sync_already_running) 由全局异常处理器统一映射为 409。
    progress = container.data_sync_service.start_sync(
        mode, target_dates=payload.dates
    )
    return to_sync_progress(progress)


@router.get(
    "/sync/status",
    response_model=SyncProgressResponse | None,
    summary="查询同步进度",
)
def sync_status(
    run_id: str | None = Query(default=None, description="任务编号, 缺省取最近一次"),
    container: Container = Depends(get_container),
) -> SyncProgressResponse | None:
    """查询同步任务进度。"""

    progress = container.data_sync_service.progress(run_id)
    return to_sync_progress(progress) if progress else None


@router.post(
    "/sync/cancel",
    response_model=SyncProgressResponse | None,
    summary="取消同步任务",
)
def cancel_sync(
    run_id: str | None = Query(default=None),
    container: Container = Depends(get_container),
) -> SyncProgressResponse | None:
    """请求取消同步任务。"""

    progress = container.data_sync_service.cancel_sync(run_id)
    return to_sync_progress(progress) if progress else None
