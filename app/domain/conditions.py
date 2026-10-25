"""可组合的筛选条件模块。

一条选股策略 = 若干"条件模块"按顺序组合 (全部满足)。
每个模块只做一件事, 参数由前端按 :data:`CONDITION_CATALOG` 的描述渲染,
因此新增条件只需在这里加一个类型, 并把说明写进目录。

本模块是纯函数集合 (除交易日历换算需要的 ``ScreenContext`` 外不做 I/O)。
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from app.domain.intervals import (
    compute_volume_ratio,
    format_interval,
    value_in_interval,
    volume_ratio_in_interval,
)
from app.domain.models import (
    DEFAULT_CRITERIA,
    DailyBar,
    ScreenCandidate,
    ScreenCriteria,
    ScreenWindow,
    node_symbol,
)

#: 条件类型 → 未通过原因的归类 (用于结果页的统计与中文标签)。
CONDITION_REASONS = {
    "pct_chg_range": "pct_chg_out_of_range",
    "volume_ratio_range": "volume_ratio_too_low",
    "cumulative_pct_chg_range": "pct_chg_out_of_range",
    "close_price_range": "condition_failed",
    "amount_range": "condition_failed",
    "listed_min_days": "newly_listed",
    "not_st": "st_stock",
}

#: 条件类型 → 中文名 (用于错误提示与漏斗标签)。
CONDITION_TITLES: dict[str, str] = {
    "pct_chg_range": "涨跌幅区间",
    "volume_ratio_range": "成交量比值区间",
    "cumulative_pct_chg_range": "累计涨跌幅区间",
    "close_price_range": "收盘价区间",
    "amount_range": "成交额区间",
    "listed_min_days": "上市时间要求",
    "not_st": "排除 ST",
}

_DAY_LABELS = {"d0": "D0 ", "d1": "D1 ", "d2": "D2 ", "all": "D0/D1/D2 三天"}

#: 旧版本参数 → 新的"时间节点 + 覆盖天数" (老策略读进来时自动升级)。
_LEGACY_DAY_OFFSETS = {"d0": -2, "d1": -1, "d2": 0}
_LEGACY_LEG_OFFSETS = {"first": -1, "second": 0}


def _migrate_params(params: Mapping[str, Any]) -> dict[str, Any]:
    """把旧参数 (day / leg) 转换为新的 offset / span。"""

    migrated = dict(params)
    day = migrated.pop("day", None)
    if day is not None and "offset" not in migrated:
        if day == "all":
            migrated["offset"] = 0
            migrated.setdefault("span", 3)
        else:
            migrated["offset"] = _LEGACY_DAY_OFFSETS.get(str(day), 0)
            migrated.setdefault("span", 1)
    leg = migrated.pop("leg", None)
    if leg is not None and "offset" not in migrated:
        migrated["offset"] = _LEGACY_LEG_OFFSETS.get(str(leg), 0)
    return migrated


def _number_spec(
    name: str,
    label: str,
    *,
    default: float | None,
    minimum: float,
    maximum: float,
    step: float = 0.5,
    signed: bool = False,
    optional: bool = True,
    role: str | None = None,
) -> dict[str, Any]:
    """数字参数描述 (前端据此渲染输入框)。"""

    return {
        "name": name,
        "label": label,
        "type": "number",
        "default": default,
        "min": minimum,
        "max": maximum,
        "step": step,
        "signed": signed,
        "optional": optional,
        "role": role,
    }


def _node_spec(default: int = 0) -> dict[str, Any]:
    """时间节点参数 (相对基准日 T0 的偏移)。"""

    return _number_spec(
        "offset",
        "检查交易日（相对基准日 T0）",
        default=default,
        minimum=-60,
        maximum=60,
        step=1,
        optional=False,
        role="node",
    )


def _span_spec(default: int = 3) -> dict[str, Any]:
    """从结束日向前数的连续交易日数量，含结束日。"""

    return _number_spec(
        "span",
        "连续交易日数（含结束日）",
        default=default,
        minimum=1,
        maximum=10,
        step=1,
        optional=False,
        role="span",
    )


#: 条件目录: 前端"策略编辑器"完全按这里的描述生成界面。
CONDITION_CATALOG: tuple[dict[str, Any], ...] = (
    {
        "kind": "pct_chg_range",
        "title": "涨跌幅区间",
        "hint": "从开始日到结束日（含首尾），每个交易日的涨跌幅都须符合上下限",
        "params": [
            _node_spec(0),
            _span_spec(3),
            _number_spec("min", "下限 (%)", default=0, minimum=-20, maximum=20, signed=True),
            _number_spec("max", "上限 (%)", default=7, minimum=-20, maximum=20, signed=True),
            {"name": "inclusive", "label": "包含上下限", "type": "bool", "default": False},
        ],
    },
    {
        "kind": "volume_ratio_range",
        "title": "成交量比值区间",
        "hint": "所选交易日的成交量 ÷ 前一个交易日的成交量，须符合上下限",
        "params": [
            _node_spec(0),
            _number_spec("min", "下限 (倍)", default=2, minimum=0, maximum=100, step=0.1),
            _number_spec("max", "上限 (倍)", default=None, minimum=0.01, maximum=100, step=0.1),
            {"name": "inclusive", "label": "包含上下限", "type": "bool", "default": False},
        ],
    },
    {
        "kind": "cumulative_pct_chg_range",
        "title": "累计涨跌幅区间",
        "hint": "从开始日当天的涨跌幅起，至结束日复利累计，只判断整段累计值",
        "params": [
            _node_spec(0),
            _span_spec(3),
            _number_spec("min", "下限 (%)", default=0, minimum=-50, maximum=100, signed=True),
            _number_spec("max", "上限 (%)", default=None, minimum=-50, maximum=100, signed=True),
            {"name": "inclusive", "label": "包含上下限", "type": "bool", "default": False},
        ],
    },
    {
        "kind": "close_price_range",
        "title": "收盘价区间",
        "hint": "所选交易日的收盘价须符合上下限（元）",
        "params": [
            _node_spec(0),
            _number_spec("min", "下限 (元)", default=None, minimum=0, maximum=10000, step=0.1),
            _number_spec("max", "上限 (元)", default=None, minimum=0, maximum=10000, step=0.1),
            {"name": "inclusive", "label": "包含上下限", "type": "bool", "default": False},
        ],
    },
    {
        "kind": "amount_range",
        "title": "成交额区间",
        "hint": "所选交易日的成交额须符合上下限（万元）",
        "params": [
            _node_spec(0),
            _number_spec(
                "min", "下限 (万元)", default=None, minimum=0, maximum=1_000_000, step=100
            ),
            _number_spec(
                "max", "上限 (万元)", default=None, minimum=0, maximum=1_000_000, step=100
            ),
            {"name": "inclusive", "label": "包含上下限", "type": "bool", "default": False},
        ],
    },
    {
        "kind": "listed_min_days",
        "title": "上市时间要求",
        "hint": "排除上市不足 N 个交易日的次新股",
        "params": [
            {
                "name": "days",
                "label": "至少上市 (交易日)",
                "type": "number",
                "default": 3,
                "min": 1,
                "max": 250,
                "step": 1,
                "optional": False,
            }
        ],
    },
    {
        "kind": "not_st",
        "title": "排除 ST",
        "hint": "所选交易日的历史简称不含 ST / *ST",
        "params": [_node_spec(0)],
    },
)

CATALOG_BY_KIND: dict[str, dict[str, Any]] = {
    entry["kind"]: entry for entry in CONDITION_CATALOG
}


@dataclass(frozen=True, slots=True)
class ScreenContext:
    """条件评估需要的额外上下文 (由服务层用交易日历预计算)。"""

    window: ScreenWindow
    #: "N 个交易日前"对应的日期, 供上市时间条件使用。
    trading_days_ago: Mapping[int, date | None] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class ConditionSpec:
    """一个条件模块实例 (类型 + 参数)。"""

    kind: str
    params: Mapping[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.kind not in CATALOG_BY_KIND:
            raise ValueError(f"未知的筛选条件类型: {self.kind!r}")

    # --- 参数读取 ---------------------------------------------------------

    def raw(self, name: str, default: Any = None) -> Any:
        value = self.params.get(name, default)
        return default if value is None else value

    def number(self, name: str, default: Decimal | None = None) -> Decimal | None:
        value = self.params.get(name)
        if value is None or value == "":
            return default
        return value if isinstance(value, Decimal) else Decimal(str(value))

    def integer(self, name: str, default: int = 0) -> int:
        value = self.params.get(name)
        if value is None or value == "":
            return default
        return int(value)

    def flag(self, name: str, default: bool = False) -> bool:
        value = self.params.get(name)
        return default if value is None else bool(value)

    def text(self, name: str, default: str = "") -> str:
        value = self.params.get(name)
        return default if value is None else str(value)

    def default_params(self) -> dict[str, Any]:
        """用目录里的默认值补齐缺失参数 (顺带把旧版 day / leg 参数升级为时间节点)。"""

        entry = CATALOG_BY_KIND[self.kind]
        merged = {item["name"]: item["default"] for item in entry["params"]}
        merged.update(_migrate_params(self.params))
        return merged

    def normalized(self) -> ConditionSpec:
        return ConditionSpec(kind=self.kind, params=self.default_params())

    def title(self) -> str:
        return CONDITION_TITLES.get(self.kind, self.kind)

    def summary(self) -> str:
        """不带"且"前缀的条件描述 (用于未通过原因)。"""

        if self.kind == "not_st":
            node = node_symbol(self.normalized().integer("offset", 0))
            return f"{node} 为 ST / *ST 股票"
        return self.label().removeprefix("且").lstrip()

    def label(self) -> str:
        """漏斗里显示的条件描述 (带参数)。"""

        spec = self.normalized()
        node = node_symbol(spec.integer("offset", 0))
        if spec.kind == "pct_chg_range":
            interval = format_interval(
                spec.number("min"),
                spec.number("max"),
                spec.flag("inclusive"),
                unit="%",
                signed=True,
            )
            span = max(1, spec.integer("span", 3))
            if span > 1:
                start = node_symbol(spec.integer("offset", 0) - span + 1)
                return f"且 {start} 至 {node}（含首尾），每天涨跌幅均落在 {interval}"
            return f"且 {node} 涨跌幅落在 {interval}"
        if spec.kind == "volume_ratio_range":
            interval = format_interval(
                spec.number("min"),
                spec.number("max"),
                spec.flag("inclusive"),
                unit=" 倍",
            )
            return f"且 {node} 量比 (较前一交易日) 落在 {interval}"
        if spec.kind == "cumulative_pct_chg_range":
            interval = format_interval(
                spec.number("min"),
                spec.number("max"),
                spec.flag("inclusive"),
                unit="%",
                signed=True,
            )
            span = max(1, spec.integer("span", 3))
            start = node_symbol(spec.integer("offset", 0) - span + 1)
            return f"且 {start} 至 {node}（含首尾）累计涨跌幅落在 {interval}"
        if spec.kind == "close_price_range":
            interval = format_interval(
                spec.number("min"), spec.number("max"), spec.flag("inclusive"), unit=" 元"
            )
            return f"且 {node} 收盘价落在 {interval}"
        if spec.kind == "amount_range":
            interval = format_interval(
                spec.number("min"), spec.number("max"), spec.flag("inclusive"), unit=" 万元"
            )
            return f"且 {node} 成交额落在 {interval}"
        if spec.kind == "listed_min_days":
            return f"且上市满 {spec.integer('days', 3)} 个交易日"
        if spec.kind == "not_st":
            return f"且 {node} 非 ST / *ST —— 最终结果"
        return f"且满足 {spec.title()}"


@dataclass(frozen=True, slots=True)
class ConditionResult:
    """单个条件的评估结果。"""

    passed: bool
    detail: str


@dataclass(frozen=True, slots=True)
class ScreenStrategy:
    """一套选股策略: 若干条件模块按顺序组合 (全部满足)。"""

    name: str
    conditions: tuple[ConditionSpec, ...] = ()
    strategy_id: int | None = None
    #: 内置策略 (随程序提供, 不允许删除)。
    builtin: bool = False
    updated_at: datetime | None = None

    @property
    def condition_count(self) -> int:
        return len(self.conditions)


def _bar_problem(bar: DailyBar | None, label: str) -> str | None:
    if bar is None:
        return f"{label} 无行情数据"
    if not bar.is_normal_trading:
        return f"{label} 非正常交易状态 (停牌)"
    if not bar.is_valid:
        return f"{label} 收盘价/成交量/涨幅字段无效"
    return None


def bar_problems(candidate: ScreenCandidate, window: ScreenWindow) -> list[str]:
    """窗口内各节点行情是否完整可用 (标准策略即 T-2 / T-1 / T0 三天)。"""

    return [
        problem
        for problem in (
            _bar_problem(candidate.bars.get(window.d0), "T-2"),
            _bar_problem(candidate.bars.get(window.d1), "T-1"),
            _bar_problem(candidate.bars.get(window.d2), "T0"),
        )
        if problem is not None
    ]


def _fmt_pct(value: Decimal | None) -> str:
    return "-" if value is None else f"{value}%"


def _fmt_ratio(value: Decimal | None) -> str:
    return "-" if value is None else f"{value}倍"


def _pct_condition(
    spec: ConditionSpec, candidate: ScreenCandidate, window: ScreenWindow
) -> ConditionResult:
    offset = spec.integer("offset", 0)
    span = max(1, spec.integer("span", 3))
    offsets = [offset - span + 1 + index for index in range(span)]
    low, high, inclusive = spec.number("min"), spec.number("max"), spec.flag("inclusive")
    interval = format_interval(low, high, inclusive, unit="%", signed=True)

    values: list[str] = []
    passed = True
    for node in offsets:
        bar = _bar_at(candidate, window, node)
        value = None if bar is None else bar.pct_chg
        values.append(f"{node_symbol(node)}={_fmt_pct(value)}")
        if not value_in_interval(value, low, high, inclusive):
            passed = False
    if passed:
        return ConditionResult(True, f"涨跌幅落在 {interval}")
    scope = (
        f"{node_symbol(offsets[0])} ~ {node_symbol(offset)} 涨幅"
        if span > 1
        else f"{node_symbol(offset)} 涨幅"
    )
    return ConditionResult(
        False, f"{scope} ({', '.join(values)}) 未全部落在涨跌幅区间 {interval}"
    )


def _bar_at(
    candidate: ScreenCandidate, window: ScreenWindow, offset: int
) -> DailyBar | None:
    """取候选股票在偏移 ``offset`` 处的行情。"""

    day = window.date_at(offset)
    if day is None:
        return None
    return candidate.bars.get(day)


def _volume_condition(
    spec: ConditionSpec, candidate: ScreenCandidate, window: ScreenWindow
) -> ConditionResult:
    offset = spec.integer("offset", 0)
    current = _bar_at(candidate, window, offset)
    previous = _bar_at(candidate, window, offset - 1)
    label = f"{node_symbol(offset)}/{node_symbol(offset - 1)}"
    low, high, inclusive = spec.number("min"), spec.number("max"), spec.flag("inclusive")
    interval = format_interval(low, high, inclusive, unit=" 倍")
    passed = volume_ratio_in_interval(
        None if current is None else current.volume,
        None if previous is None else previous.volume,
        low,
        high,
        inclusive,
    )
    ratio = None
    if current is not None and previous is not None and current.volume and previous.volume:
        ratio = compute_volume_ratio(current.volume, previous.volume)
    if passed:
        return ConditionResult(True, f"{label} 量比 {_fmt_ratio(ratio)} 落在 {interval}")
    return ConditionResult(
        False,
        f"量比 {label} ({_fmt_ratio(ratio)}) 未落在区间 {interval}",
    )


def _cumulative_condition(
    spec: ConditionSpec, candidate: ScreenCandidate, window: ScreenWindow
) -> ConditionResult:
    offset = spec.integer("offset", 0)
    span = max(1, spec.integer("span", 3))
    offsets = [offset - span + 1 + index for index in range(span)]
    bars = [_bar_at(candidate, window, node) for node in offsets]
    if any(bar is None or bar.pct_chg is None for bar in bars):
        return ConditionResult(False, "缺少涨幅数据, 无法计算累计涨幅")
    factor = Decimal(1)
    for bar in bars:
        assert bar is not None and bar.pct_chg is not None
        factor *= Decimal(1) + bar.pct_chg / Decimal(100)
    cumulative = ((factor - 1) * 100).quantize(Decimal("0.0001"))
    low, high, inclusive = spec.number("min"), spec.number("max"), spec.flag("inclusive")
    interval = format_interval(low, high, inclusive, unit="%", signed=True)
    span_text = (
        f"{node_symbol(offsets[0])} 至 {node_symbol(offset)}"
        if span > 1
        else node_symbol(offset)
    )
    if value_in_interval(cumulative, low, high, inclusive):
        return ConditionResult(True, f"{span_text} 累计涨跌幅 {cumulative}% 落在 {interval}")
    return ConditionResult(
        False, f"{span_text} 累计涨跌幅 {cumulative}% 未落在区间 {interval}"
    )


def _close_condition(
    spec: ConditionSpec, candidate: ScreenCandidate, window: ScreenWindow
) -> ConditionResult:
    node = spec.integer("offset", 0)
    bar = _bar_at(candidate, window, node)
    close = None if bar is None else bar.close
    low, high, inclusive = spec.number("min"), spec.number("max"), spec.flag("inclusive")
    interval = format_interval(low, high, inclusive, unit=" 元")
    if value_in_interval(close, low, high, inclusive):
        return ConditionResult(True, f"{node_symbol(node)} 收盘价 {close} 落在 {interval}")
    shown = close if close is not None else "-"
    return ConditionResult(
        False, f"{node_symbol(node)} 收盘价 {shown} 未落在区间 {interval}"
    )


def _amount_condition(
    spec: ConditionSpec, candidate: ScreenCandidate, window: ScreenWindow
) -> ConditionResult:
    node = spec.integer("offset", 0)
    bar = _bar_at(candidate, window, node)
    amount = None if bar is None or bar.amount is None else bar.amount / Decimal(10000)
    low, high, inclusive = spec.number("min"), spec.number("max"), spec.flag("inclusive")
    interval = format_interval(low, high, inclusive, unit=" 万元")
    if value_in_interval(amount, low, high, inclusive):
        return ConditionResult(
            True, f"{node_symbol(node)} 成交额 {amount} 万元 落在 {interval}"
        )
    return ConditionResult(
        False,
        f"{node_symbol(node)} 成交额 {amount if amount is not None else '-'} 万元 "
        f"未落在区间 {interval}",
    )


def _listing_condition(
    spec: ConditionSpec, candidate: ScreenCandidate, context: ScreenContext
) -> ConditionResult:
    days = max(1, spec.integer("days", 3))
    boundary = context.trading_days_ago.get(days)
    listing_date = candidate.stock.listing_date
    if boundary is None or listing_date is None:
        return ConditionResult(True, f"上市日期未知, 跳过 {days} 个交易日要求")
    if listing_date <= boundary:
        return ConditionResult(True, f"上市日期 {listing_date} 早于 {boundary}")
    return ConditionResult(
        False,
        f"上市日期 {listing_date} 晚于 {boundary}, 交易不足 {days} 个交易日",
    )


def _spec(kind: str, **params: Any) -> ConditionSpec:
    """构造条件实例: 显式传入的 None 表示"该方向不限制", 不会被默认值覆盖。"""

    return ConditionSpec(kind=kind, params=dict(params))


def strategy_from_criteria(criteria: ScreenCriteria = DEFAULT_CRITERIA) -> ScreenStrategy:
    """把"标准规则参数" 翻译成等价的策略条件 (供旧接口 /api/screen 的 params 使用)。

    标准规则等价于: T-2 ~ T0 三天涨跌幅落在区间、T-1 与 T0 两天量比达标、T0 非 ST。
    """

    conditions: list[ConditionSpec] = []
    if criteria.exclude_newly_listed:
        conditions.append(_spec("listed_min_days", days=3))
    conditions.append(
        _spec(
            "pct_chg_range",
            offset=0,
            span=3,
            min=criteria.pct_chg_min,
            max=criteria.pct_chg_max,
            inclusive=criteria.pct_chg_inclusive,
        )
    )
    conditions.append(
        _spec(
            "volume_ratio_range",
            offset=-1,
            min=criteria.first_volume_ratio_min,
            max=criteria.first_volume_ratio_max,
            inclusive=criteria.first_volume_ratio_inclusive,
        )
    )
    conditions.append(
        _spec(
            "volume_ratio_range",
            offset=0,
            min=criteria.second_volume_ratio_min,
            max=criteria.second_volume_ratio_max,
            inclusive=criteria.second_volume_ratio_inclusive,
        )
    )
    if criteria.exclude_st:
        conditions.append(_spec("not_st"))
    return ScreenStrategy(name="标准策略", conditions=tuple(conditions), builtin=True)


#: 默认策略 (等价于需求说明书里的固定规则)。
DEFAULT_STRATEGY = strategy_from_criteria(DEFAULT_CRITERIA)


def standard_conditions() -> tuple[str, ...]:
    """标准策略里条件的类型顺序 (供旧字段兼容映射使用)。"""

    return tuple(spec.kind for spec in DEFAULT_STRATEGY.conditions)


def evaluate_condition(
    spec: ConditionSpec,
    candidate: ScreenCandidate,
    context: ScreenContext,
) -> ConditionResult:
    """评估一条条件 (``not_st`` 需要外部 ST 判定, 由服务层处理)。"""

    window = context.window
    normalized = spec.normalized()
    if normalized.kind == "pct_chg_range":
        return _pct_condition(normalized, candidate, window)
    if normalized.kind == "volume_ratio_range":
        return _volume_condition(normalized, candidate, window)
    if normalized.kind == "cumulative_pct_chg_range":
        return _cumulative_condition(normalized, candidate, window)
    if normalized.kind == "close_price_range":
        return _close_condition(normalized, candidate, window)
    if normalized.kind == "amount_range":
        return _amount_condition(normalized, candidate, window)
    if normalized.kind == "listed_min_days":
        return _listing_condition(normalized, candidate, context)
    raise ValueError(f"条件 {normalized.kind} 需要服务层提供额外数据")  # pragma: no cover


def has_st_condition(conditions: tuple[ConditionSpec, ...]) -> bool:
    return any(spec.kind == "not_st" for spec in conditions)


def required_listing_days(conditions: tuple[ConditionSpec, ...]) -> int:
    """策略里最大的"上市满 N 个交易日"要求 (0 表示不需要)。"""

    return max(
        (max(1, spec.integer("days", 3)) for spec in conditions if spec.kind == "listed_min_days"),
        default=0,
    )


def used_offsets(conditions: tuple[ConditionSpec, ...]) -> set[int]:
    """策略用到的全部时间节点偏移。

    始终包含 0 / -1 / -2 (基准日与其前两个交易日, 用于结果表展示);
    量比条件额外需要"前一交易日", 因此会多带一个更早的节点。
    """

    offsets: set[int] = {0, -1, -2}
    for spec in conditions:
        if spec.kind == "listed_min_days":
            continue
        params = spec.default_params()
        offset = int(params.get("offset") or 0)
        span = int(params.get("span") or 1)
        for node in range(offset - span + 1, offset + 1):
            offsets.add(node)
        if spec.kind == "volume_ratio_range":
            offsets.add(offset - 1)
    return offsets


def st_offsets(conditions: tuple[ConditionSpec, ...]) -> set[int]:
    """需要做 ST 判定的时间节点。"""

    return {
        int(spec.default_params().get("offset") or 0)
        for spec in conditions
        if spec.kind == "not_st"
    }
