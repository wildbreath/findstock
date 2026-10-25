"""个股 K 线接口。"""

from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, Path, Query

from app.api.deps import get_container
from app.api.presenters import to_chart_response
from app.api.schemas import StockChartResponse, StockSearchResult
from app.container import Container
from app.core.errors import StockNotFoundError
from app.domain.sectors import StockSectors
from app.services.stock_chart_service import MAX_CHART_BARS

router = APIRouter(tags=["个股"])

CODE_PATTERN = r"^(sh|sz)\.\d{6}$"


@router.get("/stocks/search", response_model=list[StockSearchResult], summary="全市场股票搜索")
def search_stocks(
    q: str = Query(default="", max_length=80, description="股票名称或代码"),
    limit: int = Query(default=20, ge=1, le=50),
    container: Container = Depends(get_container),
) -> list[StockSearchResult]:
    return [
        StockSearchResult(
            code=stock.code, name=stock.name or stock.code,
            board=stock.board.value, board_label=stock.board.label,
        )
        for stock in container.stock_repository.search(q, limit=limit)
    ]


@router.get("/stocks/{code}/sectors", response_model=StockSectors, summary="当前所属行业及多板块")
def stock_sectors(
    code: str = Path(pattern=CODE_PATTERN),
    refresh: bool = Query(default=False, description="重新获取源端板块归属"),
    container: Container = Depends(get_container),
) -> StockSectors:
    return container.stock_sector_service.get(code, refresh=refresh)


@router.get(
    "/stocks/{code}/chart",
    response_model=StockChartResponse,
    summary="个股 K 线 (含均线)",
)
def stock_chart(
    code: str = Path(pattern=CODE_PATTERN, description="股票代码, 例如 sh.600000"),
    end: date | None = Query(
        default=None, description="只看该日期 (含) 之前的行情, 缺省为本地最新"
    ),
    limit: int = Query(
        default=180, ge=20, le=MAX_CHART_BARS, description="返回多少根 K 线"
    ),
    container: Container = Depends(get_container),
) -> StockChartResponse:
    """返回 K 线数据与 MA5 / MA10 / MA20 / MA60 均线。

    均线在返回窗口的最左端就是有效值 (服务端多取了一段数据做预热)。
    """

    chart = container.stock_chart_service.chart(code, end=end, limit=limit)
    if not chart.bars:
        raise StockNotFoundError(
            f"本地没有 {code} 的行情数据, 请先在「数据」页面下载后再查看 K 线。"
        )
    return to_chart_response(chart)
