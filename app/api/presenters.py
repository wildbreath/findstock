"""领域对象到 HTTP 响应模型的转换。"""

from __future__ import annotations

from dataclasses import asdict

from app.api.schemas import (
    BarCellOut,
    ChartBarOut,
    FunnelOut,
    FunnelStageOut,
    ScreenHitOut,
    ScreenParams,
    ScreenResponse,
    ScreenWindowOut,
    StockChartResponse,
    StrategyConditionOut,
    StrategyOut,
    SyncProgressResponse,
    WatchlistCategoryOut,
    WatchlistCategoryRef,
    WatchlistItemOut,
    WatchlistResponse,
)
from app.core.errors import InvalidRequestError
from app.domain.conditions import ConditionSpec, ScreenStrategy, validate_conditions
from app.domain.enums import Board
from app.domain.models import DEFAULT_CRITERIA, DailyBar, ScreenHit, ScreenResult, SyncProgress
from app.domain.rules import rule_description
from app.domain.symbols import split_code
from app.repositories.watchlist_repository import WatchlistCategory
from app.services.screener_service import rejection_label_counts
from app.services.stock_chart_service import StockChart, WatchlistEntry


def _as_float(value: object) -> float | None:
    return None if value is None else float(value)  # type: ignore[arg-type]


def _board_label(value: str | None) -> str:
    """把板块枚举值转成中文标签 (未知时原样返回)。"""

    if not value:
        return ""
    try:
        return Board(value).label
    except ValueError:  # pragma: no cover - 库里存了未知板块
        return value


def to_bar_cell(bar: DailyBar) -> BarCellOut:
    """行情单元格。"""

    return BarCellOut(
        trade_date=bar.trade_date,
        pct_chg=_as_float(bar.pct_chg),
        volume=bar.volume,
        close=_as_float(bar.close),
    )


def to_hit(hit: ScreenHit) -> ScreenHitOut:
    """命中股票。"""

    _, symbol = split_code(hit.code)
    return ScreenHitOut(
        code=hit.code,
        symbol=symbol,
        name=hit.name,
        board=hit.board.value,
        board_label=hit.board.label,
        d0=to_bar_cell(hit.d0_bar),
        d1=to_bar_cell(hit.d1_bar),
        d2=to_bar_cell(hit.d2_bar),
        first_volume_ratio=float(hit.first_volume_ratio),
        second_volume_ratio=float(hit.second_volume_ratio),
        st_basis=hit.st_basis.value,
        st_basis_label=hit.st_basis.label,
        st_detail=hit.st_detail,
        st_exact=hit.st_exact,
    )


def to_screen_response(result: ScreenResult) -> ScreenResponse:
    """筛选结果。"""

    criteria = result.criteria or DEFAULT_CRITERIA
    strategy = result.strategy
    message = None
    if not result.hits:
        message = (
            f"{result.window.d2.isoformat()} 没有满足全部条件的股票 "
            f"(候选 {result.funnel.universe} 只)。"
        )
    return ScreenResponse(
        selected_date=result.selected_date,
        window=ScreenWindowOut(
            selected_date=result.window.selected_date,
            d0=result.window.d0,
            d1=result.window.d1,
            d2=result.window.d2,
            previous_trading_day=result.window.previous_trading_day,
            anchor=result.window.anchor,
            nodes={
                str(offset): day for offset, day in result.window.nodes.items()
            },
        ),
        hit_count=result.hit_count,
        hits=[to_hit(hit) for hit in result.hits],
        funnel=FunnelOut(
            **{
                **asdict(result.funnel),
                "stages": [
                    FunnelStageOut(
                        key=stage.key,
                        label=stage.label,
                        count=stage.count,
                        kind=stage.kind,
                    )
                    for stage in result.funnel.stages
                ],
            }
        ),
        rejection_counts=rejection_label_counts(result),
        warnings=list(result.warnings),
        generated_at=result.generated_at,
        criteria=(
            rule_description(criteria)
            if result.criteria is not None
            else _condition_descriptions(strategy)
        ),
        params=(
            ScreenParams.from_domain(criteria)
            if result.criteria is not None
            else params_from_strategy(strategy)
        ),
        strategy=to_strategy_out(strategy),
        message=message,
    )


def to_strategy_out(strategy: ScreenStrategy | None) -> StrategyOut:
    """选股策略 (条件带中文描述)。"""

    if strategy is None:
        return StrategyOut(id=None, name="", builtin=True, conditions=[])
    return StrategyOut(
        id=strategy.strategy_id,
        name=strategy.name,
        builtin=strategy.builtin,
        updated_at=strategy.updated_at,
        condition_count=strategy.condition_count,
        conditions=[
            StrategyConditionOut(
                kind=spec.kind,
                title=spec.title(),
                label=_strategy_label(spec),
                params=dict(spec.default_params()),
            )
            for spec in strategy.conditions
        ],
    )


def _strategy_label(spec: ConditionSpec) -> str:
    try:
        return validate_conditions((spec,))[0].label()
    except InvalidRequestError as exc:
        return f"参数无效，请编辑此条件: {exc.message}"


def _condition_descriptions(strategy: ScreenStrategy | None) -> dict[str, str]:
    """策略模式下 criteria 字段的含义: 逐条条件的中文描述。"""

    if strategy is None:
        return {}
    return {
        f"condition_{index + 1}": spec.label()
        for index, spec in enumerate(strategy.conditions)
    }


def params_from_strategy(strategy: ScreenStrategy | None) -> ScreenParams | None:
    """只返回能等价表达策略的标准参数，避免给自定义条件附上错误口径。"""

    params = ScreenParams()
    if strategy is None:
        return params
    values = params.model_dump()
    values.update(
        first_volume_ratio_min=None, first_volume_ratio_max=None,
        second_volume_ratio_min=None, second_volume_ratio_max=None,
        pct_chg_min=None, pct_chg_max=None, exclude_st=False, exclude_newly_listed=False,
    )
    represented: set[tuple[str, int]] = set()
    for item in strategy.conditions:
        spec = item.normalized()
        offset = spec.integer("offset", 0)
        key = (spec.kind, offset)
        if key in represented:
            return None
        represented.add(key)
        if spec.kind == "volume_ratio_range" and offset in {-1, 0}:
            prefix = "first" if offset == -1 else "second"
            values[f"{prefix}_volume_ratio_min"] = _optional_float(spec.number("min"))
            values[f"{prefix}_volume_ratio_max"] = _optional_float(spec.number("max"))
            values[f"{prefix}_volume_ratio_inclusive"] = spec.flag("inclusive")
        elif spec.kind == "pct_chg_range" and offset == 0 and spec.integer("span", 3) == 3:
            values["pct_chg_min"] = _optional_float(spec.number("min"))
            values["pct_chg_max"] = _optional_float(spec.number("max"))
            values["pct_chg_inclusive"] = spec.flag("inclusive")
        elif spec.kind == "not_st" and offset == 0:
            values["exclude_st"] = True
        elif spec.kind == "listed_min_days":
            if spec.integer("days", 3) != 3:
                return None
            values["exclude_newly_listed"] = True
        else:
            return None
    try:
        return ScreenParams(**values)
    except ValueError:
        return None


def _optional_float(value: object) -> float | None:
    return None if value is None else float(value)  # type: ignore[arg-type]


def to_sync_progress(progress: SyncProgress) -> SyncProgressResponse:
    """同步进度。"""

    return SyncProgressResponse(
        run_id=progress.run_id,
        mode=progress.mode.value,
        mode_label=progress.mode.label,
        status=progress.status.value,
        phase=progress.phase,
        started_at=progress.started_at,
        finished_at=progress.finished_at,
        total_stocks=progress.total_stocks,
        done_stocks=progress.done_stocks,
        total_days=progress.total_days,
        done_days=progress.done_days,
        percent=progress.percent,
        message=progress.message,
        error=progress.error,
        is_running=progress.is_running,
    )


def to_chart_response(chart: StockChart) -> StockChartResponse:
    """K 线图数据。"""

    bars: list[ChartBarOut] = []
    for bar, ma in zip(chart.bars, chart.ma_values, strict=True):
        bars.append(
            ChartBarOut(
                trade_date=bar.trade_date,
                open=_as_float(bar.open),
                high=_as_float(bar.high),
                low=_as_float(bar.low),
                close=_as_float(bar.close),
                preclose=_as_float(bar.preclose),
                volume=bar.volume,
                amount=_as_float(bar.amount),
                pct_chg=_as_float(bar.pct_chg),
                ma={str(period): _as_float(value) for period, value in ma.items()},
            )
        )
    return StockChartResponse(
        code=chart.code,
        name=chart.name,
        board=chart.board,
        board_label=_board_label(chart.board),
        ma_windows=list(chart.ma_windows),
        bars=bars,
    )


def to_watchlist_item(
    entry: WatchlistEntry, category_names: dict[int, str] | None = None
) -> WatchlistItemOut:
    """自选股条目。"""

    latest = entry.latest
    names = category_names or {}
    return WatchlistItemOut(
        code=entry.item.code,
        name=entry.name,
        board=entry.board,
        board_label=_board_label(entry.board),
        added_at=entry.item.added_at,
        source_date=entry.item.source_date,
        note=entry.item.note,
        note_highlights=list(entry.item.note_highlights),
        categories=sorted(
            (
                WatchlistCategoryRef(
                    id=category_id, name=names.get(category_id, str(category_id))
                )
                for category_id in entry.item.category_ids
            ),
            key=lambda ref: ref.name,
        ),
        latest_date=None if latest is None else latest.trade_date,
        latest_close=None if latest is None else _as_float(latest.close),
        latest_pct_chg=None if latest is None else _as_float(latest.pct_chg),
    )


def to_watchlist_category(category: WatchlistCategory) -> WatchlistCategoryOut:
    """自选股分类。"""

    return WatchlistCategoryOut(
        id=category.id,
        name=category.name,
        count=category.count,
        created_at=category.created_at,
    )


def to_watchlist_response(
    entries: list[WatchlistEntry], categories: list[WatchlistCategory] | None = None
) -> WatchlistResponse:
    """自选股列表。"""

    category_list = categories or []
    names = {category.id: category.name for category in category_list}
    return WatchlistResponse(
        items=[to_watchlist_item(entry, names) for entry in entries],
        codes=[entry.item.code for entry in entries],
        categories=[to_watchlist_category(category) for category in category_list],
    )
