"""领域数据模型。"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal
from typing import TYPE_CHECKING, Any

from app.domain.enums import (
    Board,
    Exchange,
    StBasis,
    SyncMode,
    SyncStatus,
    TradeStatus,
)

if TYPE_CHECKING:  # pragma: no cover - 仅用于类型标注, 避免与 conditions 循环导入
    from app.domain.conditions import ScreenStrategy


@dataclass(frozen=True, slots=True)
class StockInfo:
    """股票基础信息。"""

    code: str
    exchange: Exchange
    symbol: str
    name: str | None
    board: Board
    ipo_date: date | None = None
    out_date: date | None = None
    listing_date: date | None = None
    is_active: bool = True

    @property
    def display_name(self) -> str:
        return self.name or self.code


@dataclass(frozen=True, slots=True)
class DailyBar:
    """单只股票单个交易日的行情。"""

    code: str
    trade_date: date
    close: Decimal | None = None
    open: Decimal | None = None
    high: Decimal | None = None
    low: Decimal | None = None
    preclose: Decimal | None = None
    volume: int | None = None
    amount: Decimal | None = None
    turnover: Decimal | None = None
    pct_chg: Decimal | None = None
    trade_status: TradeStatus | None = None

    @property
    def is_normal_trading(self) -> bool:
        """是否为正常交易状态 (非停牌)。

        数据源未提供交易状态时 (akshare 就是这样) 视为正常: 上游能返回一行
        行情本身就说明当天有成交; 只有明确标记为停牌 (0) 才算异常。
        停牌日在 akshare 里通常**根本没有这一行**, 会命中 "缺少行情" 的判断。
        """

        return self.trade_status is None or self.trade_status is TradeStatus.NORMAL

    @property
    def is_valid(self) -> bool:
        """三个必需字段 (收盘价/成交量/涨幅) 是否齐全且有效。"""

        return (
            self.close is not None
            and self.close > 0
            and self.volume is not None
            and self.volume > 0
            and self.pct_chg is not None
        )


@dataclass(frozen=True, slots=True)
class ScreenWindow:
    """一次筛选使用的时间窗口。

    用户选择的那一天是**基准日 T0**; 条件用相对偏移 (T-1 / T-2 / T+1 …)
    说明自己作用在哪一天, 因此不必再纠结"D0/D1/D2 是哪天"。

    ``d0`` / ``d1`` / ``d2`` 保留为兼容字段, 分别等于 T-2 / T-1 / T0。
    """

    selected_date: date
    d0: date
    d1: date
    d2: date
    previous_trading_day: date | None = None
    #: 偏移 → 日期; 服务层按策略用到的节点补充 (含 T-4 及更早、T+1 及以后)。
    nodes: Mapping[int, date] = field(default_factory=dict)

    @property
    def dates(self) -> tuple[date, date, date]:
        return (self.d0, self.d1, self.d2)

    @property
    def anchor(self) -> date:
        """基准日 T0。"""

        return self.d2

    def date_at(self, offset: int) -> date | None:
        """相对基准日偏移 ``offset`` 个交易日对应的日期。"""

        if offset in self.nodes:
            return self.nodes[offset]
        return {
            0: self.d2,
            -1: self.d1,
            -2: self.d0,
            -3: self.previous_trading_day,
        }.get(offset)


def node_symbol(offset: int) -> str:
    """时间节点的显示符号: 0 → T0, -1 → T-1, 1 → T+1。"""

    return "T0" if offset == 0 else f"T{offset:+d}"


@dataclass(frozen=True, slots=True)
class ScreenCandidate:
    """参与筛选的单只股票。"""

    stock: StockInfo
    name_at_d2: str | None
    bars: Mapping[date, DailyBar]


@dataclass(frozen=True, slots=True)
class ScreenHit:
    """命中筛选条件的股票。"""

    code: str
    name: str
    board: Board
    bars: tuple[DailyBar, DailyBar, DailyBar]
    first_volume_ratio: Decimal
    second_volume_ratio: Decimal
    st_basis: StBasis = StBasis.D2_SNAPSHOT
    st_detail: str = ""
    #: ST 判定是否为精确口径; 为 False 时说明历史简称缺失, 结果需要人工复核。
    st_exact: bool = True

    @property
    def d0_bar(self) -> DailyBar:
        return self.bars[0]

    @property
    def d1_bar(self) -> DailyBar:
        return self.bars[1]

    @property
    def d2_bar(self) -> DailyBar:
        return self.bars[2]


@dataclass(frozen=True, slots=True)
class FunnelStage:
    """漏斗的一级 (对应策略里的一个条件模块)。"""

    key: str
    label: str
    count: int
    kind: str = ""


@dataclass(frozen=True, slots=True)
class FunnelCounts:
    """筛选漏斗计数 (逐级收窄)。"""

    universe: int = 0
    complete_data: int = 0
    #: 逐条条件的通过数 (与策略里的条件顺序一致)。
    stages: tuple[FunnelStage, ...] = ()
    # --- 以下字段保留给"标准策略"的旧接口/旧测试 ---
    listed_long_enough: int = 0
    pct_chg_in_range: int = 0
    volume_doubled: int = 0
    not_st: int = 0


def _to_decimal(value: Any, *, field_name: str) -> Decimal:
    """把整数/浮点/字符串统一转成 Decimal (浮点走 str, 避免二进制误差)。"""

    if isinstance(value, Decimal):
        return value
    if isinstance(value, float):
        return Decimal(str(value))
    try:
        return Decimal(value)
    except Exception as exc:  # pragma: no cover - 参数已由上层校验
        raise ValueError(f"{field_name} 必须是数字, 实际为 {value!r}") from exc


def _check_interval(
    low: Decimal | None,
    high: Decimal | None,
    inclusive: bool,
    label: str,
) -> None:
    """校验区间: 下限不得大于上限; 相等时必须包含边界。"""

    if low is None or high is None:
        return
    if low > high:
        raise ValueError(f"{label}区间下限不能大于上限")
    if low == high and not inclusive:
        raise ValueError(f"{label}区间上下限相等时必须勾选「包含边界值」")


@dataclass(frozen=True, slots=True)
class ScreenCriteria:
    """可调的选股参数。

    三条区间 (第一次量比 D1/D0、第二次量比 D2/D1、涨跌幅) 都由上下限组成:

    * 任一侧为 ``None`` 表示该方向不限制 (例如量比只设下限);
    * ``*_inclusive`` 表示是否包含边界值, 默认不包含 (即严格不等式);
    * 涨跌幅是有符号的: 负值表示跌幅, 正值表示涨幅, 因此可以写成 -5% ~ +9%。

    默认值即原始需求说明书的规则 (量比 > 2 无上限, 涨幅 0% ~ 7%), 前端可以逐项调整,
    调整后的参数随请求下发。
    """

    first_volume_ratio_min: Decimal | None = Decimal("2")
    first_volume_ratio_max: Decimal | None = None
    first_volume_ratio_inclusive: bool = False
    second_volume_ratio_min: Decimal | None = Decimal("2")
    second_volume_ratio_max: Decimal | None = None
    second_volume_ratio_inclusive: bool = False
    pct_chg_min: Decimal | None = Decimal("0")
    pct_chg_max: Decimal | None = Decimal("7")
    pct_chg_inclusive: bool = False
    exclude_st: bool = True
    exclude_newly_listed: bool = True

    def __post_init__(self) -> None:
        for field_name in (
            "first_volume_ratio_min",
            "first_volume_ratio_max",
            "second_volume_ratio_min",
            "second_volume_ratio_max",
            "pct_chg_min",
            "pct_chg_max",
        ):
            value = getattr(self, field_name)
            if value is None:
                continue
            object.__setattr__(
                self, field_name, _to_decimal(value, field_name=field_name)
            )
        for field_name in ("first_volume_ratio_min", "second_volume_ratio_min"):
            value = getattr(self, field_name)
            if value is not None and value < 0:
                raise ValueError("量比下限不能为负数")
        for field_name in ("first_volume_ratio_max", "second_volume_ratio_max"):
            value = getattr(self, field_name)
            if value is not None and value <= 0:
                raise ValueError("量比上限必须大于 0")
        _check_interval(
            self.first_volume_ratio_min,
            self.first_volume_ratio_max,
            self.first_volume_ratio_inclusive,
            "第一次量比",
        )
        _check_interval(
            self.second_volume_ratio_min,
            self.second_volume_ratio_max,
            self.second_volume_ratio_inclusive,
            "第二次量比",
        )
        _check_interval(
            self.pct_chg_min, self.pct_chg_max, self.pct_chg_inclusive, "涨跌幅"
        )


#: 未指定参数时使用的默认规则。
DEFAULT_CRITERIA = ScreenCriteria()


@dataclass(frozen=True, slots=True)
class ScreenResult:
    """筛选结果。"""

    selected_date: date
    window: ScreenWindow
    hits: tuple[ScreenHit, ...]
    funnel: FunnelCounts
    #: 未通过原因 → 数量 (键是中文标签, 直接给前端展示)。
    rejection_counts: Mapping[str, int] = field(default_factory=dict)
    warnings: tuple[str, ...] = ()
    #: 本次筛选实际使用的选股参数 (前端据此展示"本次用了什么参数")。
    criteria: ScreenCriteria | None = None
    #: 本次筛选实际使用的策略 (id/name/条件列表)。
    strategy: ScreenStrategy | None = None
    generated_at: datetime | None = None

    @property
    def hit_count(self) -> int:
        return len(self.hits)


@dataclass(frozen=True, slots=True)
class ScanDayResult:
    """整月扫描中某一天的情况。"""

    day: date
    hit_count: int = 0
    #: 该天没跑成 (数据没下载 / 交易日历不足等) 时为 True。
    skipped: bool = False
    reason: str | None = None


@dataclass(frozen=True, slots=True)
class MonthScanResult:
    """把基准日 T0 遍历一个月的结果: (选出日, 命中股票) 列表。"""

    month: str
    days: tuple[ScanDayResult, ...]
    hits: tuple[tuple[date, ScreenHit], ...]

    @property
    def hit_count(self) -> int:
        return len(self.hits)




@dataclass(frozen=True, slots=True)
class DataCoverage:
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


@dataclass(frozen=True, slots=True)
class SyncProgress:
    """数据同步进度。"""

    run_id: str
    mode: SyncMode
    status: SyncStatus
    phase: str
    started_at: datetime
    finished_at: datetime | None
    total_stocks: int
    done_stocks: int
    total_days: int
    done_days: int
    message: str | None
    error: str | None

    @property
    def percent(self) -> float:
        if self.status is SyncStatus.SUCCEEDED:
            return 100.0
        if self.total_stocks <= 0:
            return 0.0
        return min(99.9, round(self.done_stocks / self.total_stocks * 100, 1))

    @property
    def is_running(self) -> bool:
        return self.status is SyncStatus.RUNNING
