"""健康检查。"""

from __future__ import annotations

from fastapi import APIRouter, Depends

from app import __version__
from app.api.deps import get_container
from app.api.schemas import HealthResponse
from app.container import Container

router = APIRouter(tags=["系统"])


@router.get("/health", response_model=HealthResponse, summary="健康检查")
def health(container: Container = Depends(get_container)) -> HealthResponse:
    """返回服务与数据库状态。"""

    initialized = container.calendar_repository.count_open_days() > 0
    return HealthResponse(
        status="ok",
        version=__version__,
        database=str(container.settings.database_path),
        initialized=initialized,
    )
