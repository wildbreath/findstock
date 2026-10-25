"""HTTP 请求/响应模型。"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StrictInt, model_validator

from app.domain.models import ScreenCriteria


class ReviewCell(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str = Field(default="", max_length=2000)
    background: str = Field(default="", pattern=r"^(#[0-9a-fA-F]{6})?$")
    color: str = Field(default="", pattern=r"^(#[0-9a-fA-F]{6})?$")
    bold: bool = False
    kind: Literal["", "theme", "stock"] = ""
    highlight: bool = False


class ReviewRow(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(pattern=r"^[a-zA-Z0-9_-]{1,64}$")
    cells: dict[date, ReviewCell] = Field(default_factory=dict, max_length=1500)
    leader: bool = False


class ReviewSheet(BaseModel):
    model_config = ConfigDict(extra="forbid")

    revision: StrictInt = Field(default=0, ge=0)
    dates: list[date] = Field(default_factory=list, max_length=1500)
    hidden_dates: list[date] = Field(default_factory=list, max_length=1500)
    rows: list[ReviewRow] = Field(default_factory=list, max_length=1000)

    @model_validator(mode="after")
    def valid_grid(self) -> ReviewSheet:
        dates = set(self.dates)
        if len(dates) != len(self.dates) or len({row.id for row in self.rows}) != len(self.rows):
            raise ValueError("日期和行编号不能重复")
        if not set(self.hidden_dates) <= dates or any(not row.cells.keys() <= dates for row in self.rows):
            raise ValueError("单元格和隐藏列必须属于表格日期")
        if sum(len(row.cells) for row in self.rows) > 50000:
            raise ValueError("单元格数量过多, 请分段整理复盘")
        if sum(len(cell.text) for row in self.rows for cell in row.cells.values()) > 2000000:
            raise ValueError("复盘文字总量过大")
        self.dates = sorted(self.dates)
        self.hidden_dates = sorted(set(self.hidden_dates))
        return self


class ErrorDetail(BaseModel):
    """结构化错误。"""

    code: str
    message: str
    details: dict[str, Any] = Field(default_factory=dict)


class ErrorResponse(BaseModel):
    """错误响应外壳。"""

    error: ErrorDetail


class HealthResponse(BaseModel):
    """健康检查。"""

    status: str
    version: str
    database: str
    initialized: bool


class TradingDayOut(BaseModel):
    """交易日。"""

    trade_date: date
    is_open: bool


class CalendarResponse(BaseModel):
    """交易日历片段。"""

    days: list[TradingDayOut]
    recent_trading_days: list[date]


class CoverageResponse(BaseModel):
    """本地数据覆盖情况。"""

    calendar_start: date | None
    calendar_end: date | None
    trading_days: int
    bar_start: date | None
    bar_end: date | None
    bar_count: int
    stock_count: int
    complete_days: int
    last_sync_at: datetime | None
    history_years: int


class EnsureCalendarRequest(BaseModel):
    """下载交易日历。"""

    years: int = Field(default=2, ge=1, le=10)


class EnsureCalendarResponse(BaseModel):
    """交易日历下载结果。"""

    trading_days: int


class StartSyncRequest(BaseModel):
    """启动同步任务。"""

    model_config = ConfigDict(use_enum_values=True)

    mode: str = Field(default="incremental", pattern="^(full|incremental|targeted)$")
    dates: list[date] = Field(default_factory=list)


class SyncProgressResponse(BaseModel):
    """同步进度。"""

    run_id: str
    mode: str
    mode_label: str
    status: str
    phase: str
    started_at: datetime
    finished_at: datetime | None
    total_stocks: int
    done_stocks: int
    total_days: int
    done_days: int
    percent: float
    message: str | None
    error: str | None
    is_running: bool


class BarCellOut(BaseModel):
    """结果表中的一格行情。"""

    trade_date: date
    pct_chg: float | None
    volume: int | None
    close: float | None


class ScreenHitOut(BaseModel):
    """命中股票。"""

    code: str
    symbol: str
    name: str
    board: str
    board_label: str
    d0: BarCellOut
    d1: BarCellOut
    d2: BarCellOut
    first_volume_ratio: float
    second_volume_ratio: float
    st_basis: str
    st_basis_label: str
    st_detail: str
    st_exact: bool


class ScreenWindowOut(BaseModel):
    """参与计算的三个交易日。"""

    selected_date: date
    d0: date
    d1: date
    d2: date
    previous_trading_day: date | None
    #: 基准日 (等于 d2 / T0)。
    anchor: date | None = None
    #: 偏移 → 日期 (字符串键, 例如 "-1"), 供前端显示 T-1 之类的符号。
    nodes: dict[str, date] = Field(default_factory=dict)


class TimeNodeOut(BaseModel):
    """时间节点 (相对基准日的偏移)。"""

    offset: int
    symbol: str
    trade_date: date | None = None


class ScreenWindowResponse(BaseModel):
    """基准日窗口: 供前端画"时间轴"并解释 T-1 / T+1 的含义。"""

    anchor: date
    is_trading_day: bool
    nodes: list[TimeNodeOut]


class ScanHitOut(BaseModel):
    """整月扫描命中的一只股票 (含它是在哪一天被选出来的)。"""

    code: str
    symbol: str
    name: str
    board: str
    board_label: str
    #: 选出该股票的基准日 T0。
    screen_date: date


class ScanDayOut(BaseModel):
    """扫描过的某一天。"""

    trade_date: date
    hit_count: int
    skipped: bool = False
    reason: str | None = None


class MonthScanResponse(BaseModel):
    """整月扫描结果。"""

    month: str
    days: list[ScanDayOut]
    hits: list[ScanHitOut]
    hit_count: int
    scanned_days: int
    skipped_days: int
    strategy: StrategyOut


class MonthScanRequest(BaseModel):
    """整月扫描请求 (与 /screen 相同的条件入口 + 指定月份)。"""

    month: str = Field(pattern=r"^\d{4}-\d{2}$", description="月份, 例如 2026-09")
    params: ScreenParams | None = None
    conditions: list[StrategyConditionIn] | None = None
    strategy_id: int | None = None


class FunnelOut(BaseModel):
    """筛选漏斗。"""

    universe: int
    complete_data: int
    #: 逐条条件的通过数 (与策略里的条件顺序一致)。
    stages: list[FunnelStageOut] = Field(default_factory=list)
    listed_long_enough: int
    pct_chg_in_range: int
    volume_doubled: int
    not_st: int


class FunnelStageOut(BaseModel):
    """漏斗的一级。"""

    key: str
    label: str
    count: int
    kind: str = ""


class ScreenParams(BaseModel):
    """可调的选股参数。

    请求与响应共用同一模型: 请求里省略时使用默认值, 响应里回显本次实际使用的参数。
    三条区间 (两次量比、涨跌幅) 都可以只设一侧, 留空 (null) 表示该方向不限制;
    ``*_inclusive`` 表示是否包含边界值, 默认不包含。
    """

    first_volume_ratio_min: float | None = Field(
        default=2.0, ge=0, le=100, description="第一次量比 (D1/D0) 下限, 留空不限制"
    )
    first_volume_ratio_max: float | None = Field(
        default=None, gt=0, le=100, description="第一次量比 (D1/D0) 上限, 留空不限制"
    )
    first_volume_ratio_inclusive: bool = Field(
        default=False, description="第一次量比是否包含上下限边界值"
    )
    second_volume_ratio_min: float | None = Field(
        default=2.0, ge=0, le=100, description="第二次量比 (D2/D1) 下限, 留空不限制"
    )
    second_volume_ratio_max: float | None = Field(
        default=None, gt=0, le=100, description="第二次量比 (D2/D1) 上限, 留空不限制"
    )
    second_volume_ratio_inclusive: bool = Field(
        default=False, description="第二次量比是否包含上下限边界值"
    )
    pct_chg_min: float | None = Field(
        default=0.0,
        ge=-20,
        le=20,
        description="三日涨跌幅下限 (%), 负数表示允许的跌幅, 留空不限制",
    )
    pct_chg_max: float | None = Field(
        default=7.0,
        ge=-20,
        le=20,
        description="三日涨跌幅上限 (%), 正数表示允许的涨幅, 留空不限制",
    )
    pct_chg_inclusive: bool = Field(
        default=False, description="涨跌幅是否包含上下限边界值"
    )
    exclude_st: bool = Field(default=True, description="是否排除 ST / *ST 股票")
    exclude_newly_listed: bool = Field(
        default=True, description="是否排除上市不足三个交易日的次新股"
    )

    @model_validator(mode="after")
    def _check_ranges(self) -> ScreenParams:
        for low, high, inclusive, label in (
            (
                self.first_volume_ratio_min,
                self.first_volume_ratio_max,
                self.first_volume_ratio_inclusive,
                "第一次量比",
            ),
            (
                self.second_volume_ratio_min,
                self.second_volume_ratio_max,
                self.second_volume_ratio_inclusive,
                "第二次量比",
            ),
            (self.pct_chg_min, self.pct_chg_max, self.pct_chg_inclusive, "涨跌幅"),
        ):
            if low is None or high is None:
                continue
            if low > high:
                raise ValueError(f"{label}区间下限不能大于上限")
            if low == high and not inclusive:
                raise ValueError(f"{label}区间上下限相等时必须勾选「包含边界值」")
        return self

    def to_domain(self) -> ScreenCriteria:
        """转换为领域层的参数对象。"""

        return ScreenCriteria(
            first_volume_ratio_min=self.first_volume_ratio_min,
            first_volume_ratio_max=self.first_volume_ratio_max,
            first_volume_ratio_inclusive=self.first_volume_ratio_inclusive,
            second_volume_ratio_min=self.second_volume_ratio_min,
            second_volume_ratio_max=self.second_volume_ratio_max,
            second_volume_ratio_inclusive=self.second_volume_ratio_inclusive,
            pct_chg_min=self.pct_chg_min,
            pct_chg_max=self.pct_chg_max,
            pct_chg_inclusive=self.pct_chg_inclusive,
            exclude_st=self.exclude_st,
            exclude_newly_listed=self.exclude_newly_listed,
        )

    @classmethod
    def from_domain(cls, criteria: ScreenCriteria) -> ScreenParams:
        """由领域参数对象构造返回模型。"""

        return cls(
            first_volume_ratio_min=_as_float(criteria.first_volume_ratio_min),
            first_volume_ratio_max=_as_float(criteria.first_volume_ratio_max),
            first_volume_ratio_inclusive=criteria.first_volume_ratio_inclusive,
            second_volume_ratio_min=_as_float(criteria.second_volume_ratio_min),
            second_volume_ratio_max=_as_float(criteria.second_volume_ratio_max),
            second_volume_ratio_inclusive=criteria.second_volume_ratio_inclusive,
            pct_chg_min=_as_float(criteria.pct_chg_min),
            pct_chg_max=_as_float(criteria.pct_chg_max),
            pct_chg_inclusive=criteria.pct_chg_inclusive,
            exclude_st=criteria.exclude_st,
            exclude_newly_listed=criteria.exclude_newly_listed,
        )


def _as_float(value: object) -> float | None:
    return None if value is None else float(value)  # type: ignore[arg-type]


#: 前端表单的取值范围与小步长 (与 ScreenParams 的字段约束保持一致)。
#: ``optional`` 为 True 表示这一侧可以留空 (该方向不限制)。
PARAM_LIMITS: dict[str, dict[str, float | bool]] = {
    "first_volume_ratio_min": {"min": 0, "max": 100, "step": 0.1, "optional": True},
    "first_volume_ratio_max": {
        "min": 0.01,
        "max": 100,
        "step": 0.1,
        "optional": True,
    },
    "second_volume_ratio_min": {"min": 0, "max": 100, "step": 0.1, "optional": True},
    "second_volume_ratio_max": {
        "min": 0.01,
        "max": 100,
        "step": 0.1,
        "optional": True,
    },
    "pct_chg_min": {"min": -20, "max": 20, "step": 0.5, "optional": True},
    "pct_chg_max": {"min": -20, "max": 20, "step": 0.5, "optional": True},
}


class ScreenRequest(BaseModel):
    """筛选请求。

    字段对外暴露为 ``date``; 内部命名避免与 ``date`` 类型同名。

    ``params`` 是旧的"标准规则参数"入口 (等价于内置标准策略);
    模块化筛选直接传 ``conditions``, 或用 ``strategy_id`` 指定保存好的策略。
    """

    model_config = ConfigDict(populate_by_name=True)

    trade_date: date = Field(alias="date", description="用户选择的交易日 D2")
    params: ScreenParams | None = Field(
        default=None, description="标准规则参数 (旧接口), 省略时用 conditions / 默认策略"
    )
    conditions: list[StrategyConditionIn] | None = Field(
        default=None, description="模块化筛选条件列表 (按顺序全部满足)"
    )
    strategy_id: int | None = Field(
        default=None, description="使用保存好的策略 (与 conditions 二选一)"
    )


class StrategyConditionIn(BaseModel):
    """一个条件模块实例 (类型 + 参数)。"""

    kind: str = Field(min_length=1, max_length=40, description="条件类型")
    params: dict[str, Any] = Field(default_factory=dict, description="条件参数")


class StrategyConditionOut(BaseModel):
    """一个条件模块实例 (含中文描述)。"""

    kind: str
    title: str
    label: str
    params: dict[str, Any]


class StrategyOut(BaseModel):
    """一套选股策略。"""

    id: int | None = None
    name: str
    builtin: bool = False
    updated_at: datetime | None = None
    condition_count: int = 0
    conditions: list[StrategyConditionOut] = Field(default_factory=list)


class StrategySaveRequest(BaseModel):
    """新建 / 更新策略。"""

    name: str = Field(min_length=1, max_length=30, description="策略名称")
    conditions: list[StrategyConditionIn] = Field(
        default_factory=list, description="条件列表 (按顺序逐条收窄)"
    )


class StrategyPreviewRequest(BaseModel):
    """仅计算组合示例，不保存策略或修改行情。"""

    conditions: list[StrategyConditionIn] = Field(default_factory=list, max_length=100)


class StrategyCatalogResponse(BaseModel):
    """条件模块目录 (前端据此渲染策略编辑器)。"""

    conditions: list[dict[str, Any]]


class ScreenResponse(BaseModel):
    """筛选响应。"""

    selected_date: date
    window: ScreenWindowOut
    hit_count: int
    hits: list[ScreenHitOut]
    funnel: FunnelOut
    rejection_counts: dict[str, int]
    warnings: list[str]
    generated_at: datetime | None
    criteria: dict[str, str]
    params: ScreenParams
    strategy: StrategyOut
    message: str | None = None


class RuleResponse(BaseModel):
    """筛选规则说明。"""

    criteria: dict[str, str]
    thresholds: dict[str, float]
    defaults: ScreenParams
    limits: dict[str, ParamLimit]


class ParamLimit(BaseModel):
    """单个参数输入框的取值范围 (optional 表示可以留空 = 该方向不限制)。"""

    min: float
    max: float
    step: float
    optional: bool = False


class ChartBarOut(BaseModel):
    """K 线图中的一根日线 (含该点的各条均线值)。"""

    trade_date: date
    open: float | None
    high: float | None
    low: float | None
    close: float | None
    preclose: float | None
    volume: int | None
    amount: float | None
    pct_chg: float | None
    #: 键是均线周期 (5/10/20/60), 值为该点的均线价。
    ma: dict[str, float | None] = Field(default_factory=dict)


class StockChartResponse(BaseModel):
    """个股 K 线图数据。"""

    code: str
    name: str
    board: str
    board_label: str
    ma_windows: list[int]
    bars: list[ChartBarOut]


class StockSearchResult(BaseModel):
    """全市场股票搜索结果。"""

    code: str
    name: str
    board: str
    board_label: str


class WatchlistItemOut(BaseModel):
    """自选股条目 (附本地最新行情)。"""

    code: str
    name: str
    board: str
    board_label: str
    added_at: datetime | None
    source_date: date | None
    note: str | None = None
    note_highlights: list[tuple[int, int]] = Field(default_factory=list)
    #: 所属分类 (同一只股票可以属于多个分类)。
    categories: list[WatchlistCategoryRef] = Field(default_factory=list)
    latest_date: date | None = None
    latest_close: float | None = None
    latest_pct_chg: float | None = None


class WatchlistCategoryRef(BaseModel):
    """自选股所属分类的引用。"""

    id: int
    name: str


class WatchlistCategoryOut(BaseModel):
    """自选股分类 (含股票数量)。"""

    id: int
    name: str
    count: int
    created_at: datetime | None = None


class WatchlistResponse(BaseModel):
    """自选股列表。"""

    items: list[WatchlistItemOut]
    codes: list[str]
    categories: list[WatchlistCategoryOut] = Field(default_factory=list)


class WatchlistCategoryRequest(BaseModel):
    """新建自选股分类。"""

    name: str = Field(min_length=1, max_length=20, description="分类名称")


class WatchlistUpdateRequest(BaseModel):
    """更新自选股 (备注 / 分类)。仅传需要的字段。"""

    note: str | None = Field(default=None, max_length=500, description="备注, 留空即清空")
    note_highlights: list[tuple[StrictInt, StrictInt]] = Field(
        default_factory=list, max_length=500,
        description="备注高亮区间 [起点, 终点), 按 Unicode 字符计数",
    )
    category_ids: list[int] | None = Field(
        default=None, description="所属分类 id 列表, 传入即整体替换"
    )


class WatchlistOrderRequest(BaseModel):
    """按期望顺序提交全部自选股代码。"""

    codes: list[str]


class WatchlistStockRequest(BaseModel):
    """待加入的股票。"""

    code: str = Field(
        pattern=r"^(sh|sz)\.\d{6}$", description="股票代码, 例如 sh.600000"
    )
    name: str | None = Field(default=None, description="简称 (可选, 缺省用本地基础信息)")


class WatchlistAddRequest(WatchlistStockRequest):
    """加入自选股。"""

    source_date: date | None = Field(default=None, description="来源筛选日 (D2)")
    note: str | None = Field(default=None, description="备注")
    category_ids: list[int] | None = Field(
        default=None, description="加入时设置分类; 不传则保留已有分类"
    )


class WatchlistBatchAddRequest(BaseModel):
    """一次加入选中的股票，已有自选可追加或重新设置分类。"""

    items: list[WatchlistStockRequest] = Field(min_length=1, max_length=1000)
    source_date: date
    category_ids: list[StrictInt] = Field(default_factory=list, max_length=1000)
    replace_categories: bool = False
