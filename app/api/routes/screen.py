"""筛选接口。"""

from __future__ import annotations

import csv
import io
from datetime import date

from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse

from app.api.deps import get_container
from app.api.presenters import to_screen_response, to_strategy_out
from app.api.schemas import (
    PARAM_LIMITS,
    MonthScanRequest,
    MonthScanResponse,
    RuleResponse,
    ScanDayOut,
    ScanHitOut,
    ScreenParams,
    ScreenRequest,
    ScreenResponse,
    ScreenWindowResponse,
    TimeNodeOut,
)
from app.container import Container
from app.core.errors import InvalidRequestError
from app.domain.conditions import (
    CATALOG_BY_KIND,
    DEFAULT_STRATEGY,
    ConditionSpec,
    ScreenStrategy,
    strategy_from_criteria,
)
from app.domain.models import ScreenCriteria, node_symbol
from app.domain.rules import (
    PCT_CHG_UPPER_BOUND,
    VOLUME_RATIO_THRESHOLD,
    rule_description,
)
from app.domain.symbols import split_code

router = APIRouter(tags=["筛选"])


def query_criteria(
    first_volume_ratio_min: float | None = Query(
        default=2.0, ge=0, le=100, description="第一次量比 (D1/D0) 下限, 留空不限制"
    ),
    first_volume_ratio_max: float | None = Query(
        default=None, gt=0, le=100, description="第一次量比 (D1/D0) 上限, 留空不限制"
    ),
    first_volume_ratio_inclusive: bool = Query(
        default=False, description="第一次量比是否含边界"
    ),
    second_volume_ratio_min: float | None = Query(
        default=2.0, ge=0, le=100, description="第二次量比 (D2/D1) 下限, 留空不限制"
    ),
    second_volume_ratio_max: float | None = Query(
        default=None, gt=0, le=100, description="第二次量比 (D2/D1) 上限, 留空不限制"
    ),
    second_volume_ratio_inclusive: bool = Query(
        default=False, description="第二次量比是否含边界"
    ),
    pct_chg_min: float | None = Query(
        default=0.0, ge=-20, le=20, description="三日涨跌幅下限 (%), 负数=跌幅, 留空不限制"
    ),
    pct_chg_max: float | None = Query(
        default=7.0, ge=-20, le=20, description="三日涨跌幅上限 (%), 正数=涨幅, 留空不限制"
    ),
    pct_chg_inclusive: bool = Query(
        default=False, description="涨跌幅是否含边界"
    ),
    exclude_st: bool = Query(default=True, description="是否排除 ST / *ST"),
    exclude_newly_listed: bool = Query(default=True, description="是否排除次新股"),
) -> ScreenCriteria:
    """GET 接口的选股参数 (与 POST body 的 params 等价)。"""

    try:
        return ScreenParams(
            first_volume_ratio_min=first_volume_ratio_min,
            first_volume_ratio_max=first_volume_ratio_max,
            first_volume_ratio_inclusive=first_volume_ratio_inclusive,
            second_volume_ratio_min=second_volume_ratio_min,
            second_volume_ratio_max=second_volume_ratio_max,
            second_volume_ratio_inclusive=second_volume_ratio_inclusive,
            pct_chg_min=pct_chg_min,
            pct_chg_max=pct_chg_max,
            pct_chg_inclusive=pct_chg_inclusive,
            exclude_st=exclude_st,
            exclude_newly_listed=exclude_newly_listed,
        ).to_domain()
    except ValueError as exc:
        raise InvalidRequestError(f"选股参数不合法: {exc}") from exc


@router.post("/screen", response_model=ScreenResponse, summary="按日期执行筛选")
def run_screen(
    payload: ScreenRequest,
    container: Container = Depends(get_container),
) -> ScreenResponse:
    """按用户选择的交易日与策略/参数执行筛选。"""

    return to_screen_response(_run_screen(payload, container))


def _resolve_strategy(payload, container: Container):
    """统一的策略入口: conditions / strategy_id / params / 默认策略。"""

    if payload.conditions is not None:
        specs: list[ConditionSpec] = []
        for item in payload.conditions:
            if item.kind not in CATALOG_BY_KIND:
                raise InvalidRequestError(f"未知的条件类型: {item.kind}")
            specs.append(ConditionSpec(kind=item.kind, params=dict(item.params)))
        return (
            ScreenStrategy(name="自定义条件", conditions=tuple(specs)),
            None,
        )
    if payload.strategy_id is not None:
        saved = container.strategy_repository.get(payload.strategy_id)
        if saved is None:
            raise InvalidRequestError(f"策略 {payload.strategy_id} 不存在。")
        return saved, None
    if payload.params is not None:
        return None, payload.params.to_domain()
    return DEFAULT_STRATEGY, None


def _run_screen(payload: ScreenRequest, container: Container):
    """按请求里的策略/参数执行单日筛选。"""

    strategy, criteria = _resolve_strategy(payload, container)
    return container.screener_service.screen(
        payload.trade_date, criteria=criteria, strategy=strategy
    )


@router.post(
    "/screen/scan",
    response_model=MonthScanResponse,
    summary="整月扫描: 用 T0 遍历一个月, 汇总命中的股票",
)
def scan_month(
    payload: MonthScanRequest,
    container: Container = Depends(get_container),
) -> MonthScanResponse:
    """把基准日 T0 依次取该月每个交易日, 汇总所有符合条件的股票。"""

    strategy, criteria = _resolve_strategy(payload, container)
    result = container.screener_service.scan_month(
        payload.month, criteria=criteria, strategy=strategy
    )
    # 回显本次使用的策略 (走 params/默认时用标准策略)
    resolved = strategy
    if resolved is None:
        resolved = (
            strategy_from_criteria(criteria) if criteria is not None else DEFAULT_STRATEGY
        )
    return MonthScanResponse(
        month=result.month,
        days=[
            ScanDayOut(
                trade_date=item.day,
                hit_count=item.hit_count,
                skipped=item.skipped,
                reason=item.reason,
            )
            for item in result.days
        ],
        hits=[
            ScanHitOut(
                code=hit.code,
                symbol=split_code(hit.code)[1],
                name=hit.name,
                board=hit.board.value,
                board_label=hit.board.label,
                screen_date=day,
            )
            for day, hit in result.hits
        ],
        hit_count=result.hit_count,
        scanned_days=len([item for item in result.days if not item.skipped]),
        skipped_days=len([item for item in result.days if item.skipped]),
        strategy=to_strategy_out(resolved),
    )


@router.post("/screen/scan/export", summary="导出整月扫描结果 (CSV)")
def export_scan(
    payload: MonthScanRequest,
    container: Container = Depends(get_container),
) -> StreamingResponse:
    """整月扫描结果导出 (只含 自选日 + 代码 + 简称 + 板块 四列)。"""

    strategy, criteria = _resolve_strategy(payload, container)
    result = container.screener_service.scan_month(
        payload.month, criteria=criteria, strategy=strategy
    )
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(["选出日(T0)", "股票代码", "股票简称", "板块"])
    for day, hit in result.hits:
        writer.writerow([day.isoformat(), hit.code, hit.name, hit.board.label])
    filename = f"screen_scan_{result.month}.csv"
    content = "\ufeff" + buffer.getvalue()
    return StreamingResponse(
        iter([content]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
    return container.screener_service.screen(
        payload.trade_date, strategy=DEFAULT_STRATEGY
    )


@router.post("/screen/export", summary="按策略导出筛选结果 (CSV)")
def export_screen_post(
    payload: ScreenRequest,
    container: Container = Depends(get_container),
) -> StreamingResponse:
    """与 `GET /screen/export` 等价, 但支持模块化的条件列表。"""

    return _csv_response(_run_screen(payload, container))


@router.get(
    "/screen/window",
    response_model=ScreenWindowResponse,
    summary="基准日前后时间节点 (T-1 / T0 / T+1)",
)
def screen_window(
    day: date | None = Query(
        default=None, alias="date", description="基准日 T0, 缺省用本地最新交易日"
    ),
    back: int = Query(default=6, ge=1, le=60, description="往前取多少个节点"),
    forward: int = Query(default=2, ge=0, le=10, description="往后取多少个节点"),
    container: Container = Depends(get_container),
) -> ScreenWindowResponse:
    """返回基准日前后每个时间节点的日期与符号, 供前端画时间轴。"""

    calendar = container.calendar_repository
    service = container.calendar_service
    if day is None:
        day = service.latest_complete_trading_day() or calendar.latest_open_day()
        if day is None:
            return ScreenWindowResponse(anchor=date.today(), is_trading_day=False, nodes=[])
    past = calendar.open_days_on_or_before(day, back + 1)
    is_trading_day = bool(past) and past[0] == day
    nodes: list[TimeNodeOut] = []
    recent = past if is_trading_day else service.recent_open_days(day, back + 1)
    for index, value in enumerate(recent):
        nodes.append(
            TimeNodeOut(offset=-index, symbol=node_symbol(-index), trade_date=value)
        )
    if forward:
        for index, value in enumerate(
            service.following_open_days(day, forward), start=1
        ):
            nodes.append(
                TimeNodeOut(
                    offset=index, symbol=node_symbol(index), trade_date=value
                )
            )
    nodes.sort(key=lambda item: item.offset)
    return ScreenWindowResponse(anchor=day, is_trading_day=is_trading_day, nodes=nodes)


@router.get("/screen", response_model=ScreenResponse, summary="按日期执行筛选 (GET)")
def run_screen_get(
    day: date = Query(alias="date", description="用户选择的交易日 D2"),
    criteria: ScreenCriteria = Depends(query_criteria),
    container: Container = Depends(get_container),
) -> ScreenResponse:
    """与 POST /screen 等价, 便于直接以链接调用。"""

    result = container.screener_service.screen(day, criteria)
    return to_screen_response(result)


@router.get("/screen/export", summary="导出筛选结果为 CSV")
def export_screen(
    day: date = Query(alias="date", description="用户选择的交易日 D2"),
    criteria: ScreenCriteria = Depends(query_criteria),
    container: Container = Depends(get_container),
) -> StreamingResponse:
    """把筛选结果导出为 CSV (带 BOM, 便于 Excel 直接打开)。

    参数与 /screen 一致, 因此导出的就是页面上看到的结果。
    """

    result = container.screener_service.screen(day, criteria)
    return _csv_response(result)


def _csv_response(result) -> StreamingResponse:
    """把筛选结果写成 CSV (带 BOM, 便于 Excel 直接打开)。"""

    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(
        [
            "股票代码",
            "股票简称",
            "板块",
            "T-2日期",
            "T-2涨幅(%)",
            "T-2成交量(股)",
            "T-1日期",
            "T-1涨幅(%)",
            "T-1成交量(股)",
            "T-1量比(较T-2)",
            "T0日期(基准日)",
            "T0涨幅(%)",
            "T0成交量(股)",
            "T0量比(较T-1)",
        ]
    )
    for hit in result.hits:
        writer.writerow(
            [
                hit.code,
                hit.name,
                hit.board.label,
                hit.d0_bar.trade_date.isoformat(),
                "" if hit.d0_bar.pct_chg is None else hit.d0_bar.pct_chg,
                hit.d0_bar.volume,
                hit.d1_bar.trade_date.isoformat(),
                "" if hit.d1_bar.pct_chg is None else hit.d1_bar.pct_chg,
                hit.d1_bar.volume,
                hit.first_volume_ratio,
                hit.d2_bar.trade_date.isoformat(),
                "" if hit.d2_bar.pct_chg is None else hit.d2_bar.pct_chg,
                hit.d2_bar.volume,
                hit.second_volume_ratio,
            ]
        )

    filename = f"screen_{result.window.d2.isoformat()}.csv"
    content = "\ufeff" + buffer.getvalue()
    return StreamingResponse(
        iter([content]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/rules", response_model=RuleResponse, summary="筛选规则说明")
def get_rules() -> RuleResponse:
    """返回默认筛选规则与参数取值范围 (前端据此渲染参数面板)。"""

    return RuleResponse(
        criteria=rule_description(),
        thresholds={
            "volume_ratio_strictly_greater_than": float(VOLUME_RATIO_THRESHOLD),
            "pct_chg_strictly_greater_than": 0.0,
            "pct_chg_strictly_less_than": float(PCT_CHG_UPPER_BOUND),
        },
        defaults=ScreenParams(),
        limits=PARAM_LIMITS,
    )
