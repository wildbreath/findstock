"""自选股接口 (含备注与自定义分类)。"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Path, status
from pydantic import BaseModel

from app.api.deps import get_container
from app.api.presenters import (
    to_watchlist_category,
    to_watchlist_item,
    to_watchlist_response,
)
from app.api.schemas import (
    WatchlistAddRequest,
    WatchlistBatchAddRequest,
    WatchlistCategoryOut,
    WatchlistCategoryRequest,
    WatchlistItemOut,
    WatchlistOrderRequest,
    WatchlistResponse,
    WatchlistUpdateRequest,
)
from app.container import Container
from app.core.errors import StockNotFoundError

router = APIRouter(prefix="/watchlist", tags=["自选股"])

CODE_PATTERN = r"^(sh|sz)\.\d{6}$"


class WatchlistRemoveResponse(BaseModel):
    """移除结果。"""

    code: str
    removed: bool


class WatchlistCategoryRemoveResponse(BaseModel):
    """删除分类的结果。"""

    id: int
    removed: bool


@router.get("", response_model=WatchlistResponse, summary="自选股列表")
def list_watchlist(
    container: Container = Depends(get_container),
) -> WatchlistResponse:
    """列出全部自选股 (含备注、分类), 附本地最新收盘价与涨跌幅。"""

    service = container.stock_chart_service
    return to_watchlist_response(service.watchlist(), service.categories())


@router.get(
    "/categories",
    response_model=list[WatchlistCategoryOut],
    summary="自选股分类列表",
)
def list_categories(
    container: Container = Depends(get_container),
) -> list[WatchlistCategoryOut]:
    """列出全部自选股分类 (含每个分类的股票数量)。"""

    return [
        to_watchlist_category(category)
        for category in container.stock_chart_service.categories()
    ]


@router.post(
    "/categories",
    response_model=WatchlistCategoryOut,
    status_code=status.HTTP_201_CREATED,
    summary="新建自选股分类",
)
def create_category(
    payload: WatchlistCategoryRequest,
    container: Container = Depends(get_container),
) -> WatchlistCategoryOut:
    """新建分类; 同名分类直接返回已有的那条。"""

    category = container.stock_chart_service.create_category(payload.name)
    return to_watchlist_category(category)


@router.delete(
    "/categories/{category_id}",
    response_model=WatchlistCategoryRemoveResponse,
    summary="删除自选股分类",
)
def delete_category(
    category_id: int = Path(description="分类 id"),
    container: Container = Depends(get_container),
) -> WatchlistCategoryRemoveResponse:
    """删除分类 (股票本身保留, 只是不再属于该分类)。"""

    removed = container.stock_chart_service.delete_category(category_id)
    return WatchlistCategoryRemoveResponse(id=category_id, removed=removed)


@router.post(
    "",
    response_model=WatchlistItemOut,
    status_code=status.HTTP_201_CREATED,
    summary="加入自选股",
)
def add_watchlist(
    payload: WatchlistAddRequest,
    container: Container = Depends(get_container),
) -> WatchlistItemOut:
    """加入自选股 (重复收藏视为更新, 不会产生重复记录)。"""

    service = container.stock_chart_service
    service.add_to_watchlist(
        payload.code,
        name=payload.name,
        source_date=payload.source_date,
        note=payload.note,
        category_ids=payload.category_ids,
    )
    for entry in service.watchlist():
        if entry.item.code == payload.code:
            names = {c.id: c.name for c in service.categories()}
            return to_watchlist_item(entry, names)
    raise AssertionError("收藏后应当能读到该股票")  # pragma: no cover - 防御性


@router.put("/order", response_model=WatchlistOrderRequest, summary="保存自选股卡片顺序")
def reorder_watchlist(
    payload: WatchlistOrderRequest,
    container: Container = Depends(get_container),
) -> WatchlistOrderRequest:
    return WatchlistOrderRequest(
        codes=container.stock_chart_service.reorder_watchlist(payload.codes)
    )


@router.post("/batch", response_model=WatchlistResponse, summary="批量加入自选并设置分类")
def add_watchlist_batch(
    payload: WatchlistBatchAddRequest,
    container: Container = Depends(get_container),
) -> WatchlistResponse:
    service = container.stock_chart_service
    service.add_many_to_watchlist(
        [(item.code, item.name) for item in payload.items], source_date=payload.source_date,
        category_ids=payload.category_ids, replace_categories=payload.replace_categories,
    )
    return to_watchlist_response(service.watchlist(), service.categories())


@router.patch(
    "/{code}",
    response_model=WatchlistItemOut,
    summary="更新自选股备注 / 分类",
)
def update_watchlist(
    payload: WatchlistUpdateRequest,
    code: str = Path(pattern=CODE_PATTERN, description="股票代码, 例如 sh.600000"),
    container: Container = Depends(get_container),
) -> WatchlistItemOut:
    """更新备注或分类; 只传需要修改的字段。"""

    service = container.stock_chart_service
    current = container.watchlist_repository.get(code)
    if current is None:
        raise StockNotFoundError(f"{code} 不在自选股里, 无法更新。")
    fields = payload.model_fields_set
    if "note" in fields or "note_highlights" in fields:
        service.update_note(
            code, payload.note if "note" in fields else current.note,
            note_highlights=payload.note_highlights,
            category_ids=payload.category_ids,
        )
    elif payload.category_ids is not None:
        service.set_categories(code, payload.category_ids)
    for entry in service.watchlist():
        if entry.item.code == code:
            names = {c.id: c.name for c in service.categories()}
            return to_watchlist_item(entry, names)
    raise StockNotFoundError(f"{code} 不在自选股里, 无法更新。")


@router.delete(
    "/{code}",
    response_model=WatchlistRemoveResponse,
    summary="移出自选股",
)
def remove_watchlist(
    code: str = Path(pattern=CODE_PATTERN, description="股票代码, 例如 sh.600000"),
    container: Container = Depends(get_container),
) -> WatchlistRemoveResponse:
    """把股票移出自选股。"""

    removed = container.stock_chart_service.remove_from_watchlist(code)
    return WatchlistRemoveResponse(code=code, removed=removed)
