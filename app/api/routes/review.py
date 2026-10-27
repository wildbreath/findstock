"""手工复盘表的读取、保存及日期列。"""

from datetime import date, timedelta

from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from app.api.deps import get_container
from app.api.schemas import ReviewAddStocksRequest, ReviewCollectRequest, ReviewSheet
from app.container import Container
from app.core.errors import InvalidRequestError

router = APIRouter(prefix="/review-sheet", tags=["手工复盘"])


def _conflict():
    return JSONResponse(status_code=409, content={"error": {
        "code": "review_conflict",
        "message": "复盘表已在其他页面更新。当前编辑已保留，请导出备份后重新读取。",
    }})


@router.get("", response_model=ReviewSheet, summary="读取手工复盘表")
def get_review_sheet(container: Container = Depends(get_container)) -> dict:
    return container.review_repository.get()


@router.put("", response_model=ReviewSheet, summary="保存手工复盘表")
def save_review_sheet(payload: ReviewSheet, container: Container = Depends(get_container)):
    saved = container.review_repository.save(payload.model_dump(mode="json"))
    if saved is None:
        return _conflict()
    return saved


@router.get("/collect-dates", summary="可用于复盘收录的本地收盘日期")
def collect_dates(container: Container = Depends(get_container)) -> dict:
    return {"dates": container.review_collection_service.dates()}


@router.post("/stock-rows", summary="生成手动加入的股票行并补齐本地收盘行情，不直接保存")
def prepare_stock_rows(payload: ReviewAddStocksRequest, container: Container = Depends(get_container)) -> dict:
    theme = payload.theme.strip()
    if not theme:
        raise InvalidRequestError("请选择或填写题材。")
    result = container.review_collection_service.prepare_stock_rows(
        [stock.model_dump() for stock in payload.stocks], theme, payload.trade_date,
    )
    try:
        validated = ReviewSheet.model_validate({"dates": result["dates"], "rows": result["rows"]})
    except ValidationError:
        raise InvalidRequestError("补齐后超出复盘表容量，请减少股票数量后重试。") from None
    return {**result, "rows": validated.model_dump(mode="json")["rows"]}


@router.post("/collect", summary="一次收录或更新一个交易日")
def collect_review_day(payload: ReviewCollectRequest, container: Container = Depends(get_container)):
    sheet = ReviewSheet.model_validate(container.review_repository.get()).model_dump(mode="json")
    if payload.revision != sheet["revision"]:
        return _conflict()
    result = container.review_collection_service.fill(sheet, payload.trade_date)
    try:
        validated = ReviewSheet.model_validate(result["sheet"]).model_dump(mode="json")
    except ValidationError:
        raise InvalidRequestError("收录后超出复盘表容量或文字限制，请整理表格后重试；原有数据未改动。") from None
    saved = container.review_repository.save(validated)
    if saved is None:
        return _conflict()
    return {**result, "sheet": saved}


@router.get("/dates", summary="生成复盘日期列, 无交易日历时仅跳过周末")
def review_dates(
    start: date = Query(), end: date = Query(),
    container: Container = Depends(get_container),
) -> dict:
    if not 0 <= (end - start).days <= 365:
        raise InvalidRequestError("请选择不超过一年的有效日期区间。")
    with container.database.session() as conn:
        known = {row["trade_date"]: bool(row["is_open"]) for row in conn.execute(
            "SELECT trade_date, is_open FROM trading_day WHERE trade_date BETWEEN ? AND ?",
            (start.isoformat(), end.isoformat()),
        )}
    dates, provisional = [], []
    for offset in range((end - start).days + 1):
        day = start + timedelta(days=offset)
        key = day.isoformat()
        if key not in known:
            provisional.append(key)
        if known.get(key, day.weekday() < 5):
            dates.append(key)
    return {"dates": dates, "provisional": bool(provisional)}
