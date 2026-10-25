"""手工复盘表的读取、保存及日期列。"""

from datetime import date, timedelta

from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse

from app.api.deps import get_container
from app.api.schemas import ReviewSheet
from app.container import Container
from app.core.errors import InvalidRequestError

router = APIRouter(prefix="/review-sheet", tags=["手工复盘"])


@router.get("", response_model=ReviewSheet, summary="读取手工复盘表")
def get_review_sheet(container: Container = Depends(get_container)) -> dict:
    return container.review_repository.get()


@router.put("", response_model=ReviewSheet, summary="保存手工复盘表")
def save_review_sheet(payload: ReviewSheet, container: Container = Depends(get_container)):
    saved = container.review_repository.save(payload.model_dump(mode="json"))
    if saved is None:
        return JSONResponse(status_code=409, content={"error": {
            "code": "review_conflict",
            "message": "复盘表已在其他页面更新。当前编辑已保留，请导出备份后重新读取。",
        }})
    return saved


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
