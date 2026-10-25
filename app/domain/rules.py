"""筛选规则实现。

本模块为纯函数集合, 不做任何 I/O, 因此可以用单元测试穷尽边界情况。

默认规则 (用户需求说明书 五):
    D1成交量 / D0成交量 > 2
    D2成交量 / D1成交量 > 2
    0% < D0涨幅 < 7%
    0% < D1涨幅 < 7%
    0% < D2涨幅 < 7%
    D2 不是 ST / *ST 股票
    D0、D1、D2 均有完整有效的交易数据

这些阈值都可以由前端调整, 见 :class:`ScreenCriteria`; 不传参数时使用上面的默认值。

所有比较均为严格不等式, 且使用整数/Decimal 精确比较, 不使用浮点数,
以避免 2.0、0.0%、7.0% 这类边界值被浮点误差误判。
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from unicodedata import normalize

from app.domain.conditions import (
    ConditionResult,
    ScreenContext,
    bar_problems,
    evaluate_condition,
    strategy_from_criteria,
)
from app.domain.enums import RejectionReason
from app.domain.intervals import (
    RATIO_QUANTUM,
    compute_volume_ratio,
    format_interval,
    to_decimal,
    value_in_interval,
    volume_ratio_in_interval,
)
from app.domain.models import (
    DEFAULT_CRITERIA,
    DailyBar,
    ScreenCandidate,
    ScreenCriteria,
    ScreenWindow,
)

# --- 默认阈值 (严格不等式, 来自 ScreenCriteria 的默认值) -------------------

VOLUME_RATIO_THRESHOLD = DEFAULT_CRITERIA.first_volume_ratio_min
VOLUME_RATIO_THRESHOLD_INT = int(VOLUME_RATIO_THRESHOLD)
PCT_CHG_LOWER_BOUND = DEFAULT_CRITERIA.pct_chg_min
PCT_CHG_UPPER_BOUND = DEFAULT_CRITERIA.pct_chg_max

ST_MARKER = "ST"

# 这些原语已抽到 app.domain.intervals, 这里保留导入以便旧调用方继续使用。
__all__ = [
    "RATIO_QUANTUM",
    "compute_volume_ratio",
    "format_interval",
    "to_decimal",
    "value_in_interval",
    "volume_ratio_in_interval",
]


def is_st_name(name: str | None) -> bool:
    """判断股票简称是否含 ST 标记。

    先做 NFKC 归一化, 因此大小写、全角字符、全角星号等写法都能覆盖。
    """

    if not name:
        return False
    normalized = normalize("NFKC", name).upper().replace("*", "").strip()
    return ST_MARKER in normalized


def is_pct_chg_in_range(
    pct_chg: Decimal | None,
    criteria: ScreenCriteria = DEFAULT_CRITERIA,
) -> bool:
    """涨跌幅是否落在设定区间内 (负值为跌幅, 正值为涨幅)。"""

    return value_in_interval(
        pct_chg, criteria.pct_chg_min, criteria.pct_chg_max, criteria.pct_chg_inclusive
    )


def is_volume_doubled(
    current_volume: int | None,
    previous_volume: int | None,
    threshold: Decimal = VOLUME_RATIO_THRESHOLD,
) -> bool:
    """当前成交量 / 前一交易日成交量 是否严格大于阈值 (单边阈值, 保留兼容)。"""

    return volume_ratio_in_interval(
        current_volume, previous_volume, to_decimal(threshold), None, False
    )


@dataclass(frozen=True, slots=True)
class Evaluation:
    """单只股票在 "量价条件" 上的评估结果。

    ST 判定需要额外的历史简称数据, 因此不在这里做, 由
    :mod:`app.domain.st_policy` 在候选集缩小之后单独处理。
    """

    complete_data: bool
    listed_long_enough: bool
    pct_chg_in_range: bool
    volume_doubled: bool
    reason: RejectionReason | None
    detail: str
    first_volume_ratio: Decimal | None = None
    second_volume_ratio: Decimal | None = None

    @property
    def passed(self) -> bool:
        return self.reason is None


def _bar_problem(bar: DailyBar | None, label: str) -> str | None:
    if bar is None:
        return f"{label} 无行情数据"
    if not bar.is_normal_trading:
        return f"{label} 非正常交易状态 (停牌)"
    if not bar.is_valid:
        return f"{label} 收盘价/成交量/涨幅字段无效"
    return None


def evaluate_candidate(
    candidate: ScreenCandidate,
    window: ScreenWindow,
    criteria: ScreenCriteria = DEFAULT_CRITERIA,
) -> Evaluation:
    """按优先级评估一只股票 (标准策略)。

    真正的判定交给模块化的条件引擎 (:mod:`app.domain.conditions`) —— 这里把
    "标准规则参数" 翻译成等价的策略, 再把结果整理成旧的 :class:`Evaluation` 形状,
    保证历史上按固定规则写的调用方与测试继续可用。
    """

    d0 = candidate.bars.get(window.d0)
    d1 = candidate.bars.get(window.d1)
    d2 = candidate.bars.get(window.d2)

    problems = bar_problems(candidate, window)
    complete_data = not problems

    strategy = strategy_from_criteria(criteria)
    context = ScreenContext(
        window=window, trading_days_ago={3: window.previous_trading_day}
    )
    evaluated = [
        (spec, evaluate_condition(spec, candidate, context))
        for spec in strategy.conditions
        # ST 判定需要历史简称 (要联网/查缓存), 不在本层处理。
        if spec.kind != "not_st"
    ]

    def find(kind: str, offset: int | None = None) -> ConditionResult | None:
        for spec, result in evaluated:
            if spec.kind == kind and (
                offset is None or spec.integer("offset", 0) == offset
            ):
                return result
        return None

    listed = find("listed_min_days")
    listed_long_enough = True if listed is None else listed.passed
    pct_range = find("pct_chg_range")
    pct_chg_in_range = complete_data and (True if pct_range is None else pct_range.passed)
    first_leg = find("volume_ratio_range", -1)
    second_leg = find("volume_ratio_range", 0)

    first_ratio: Decimal | None = None
    second_ratio: Decimal | None = None
    if d0 is not None and d1 is not None and d0.volume and d1.volume:
        first_ratio = compute_volume_ratio(d1.volume, d0.volume)
    if d1 is not None and d2 is not None and d1.volume and d2.volume:
        second_ratio = compute_volume_ratio(d2.volume, d1.volume)

    volume_doubled = complete_data and all(
        True if leg is None else leg.passed for leg in (first_leg, second_leg)
    )

    reason: RejectionReason | None = None
    detail = "符合全部筛选条件"
    if not complete_data:
        reason = RejectionReason.INCOMPLETE_DATA
        detail = "; ".join(problems)
    elif not listed_long_enough:
        reason = RejectionReason.NEWLY_LISTED
        assert listed is not None
        detail = listed.detail
    elif not pct_chg_in_range:
        reason = RejectionReason.PCT_CHG_OUT_OF_RANGE
        assert pct_range is not None
        detail = pct_range.detail
    elif not volume_doubled:
        reason = RejectionReason.VOLUME_RATIO_TOO_LOW
        failing = next(
            (
                leg
                for leg in (first_leg, second_leg)
                if leg is not None and not leg.passed
            ),
            None,
        )
        detail = failing.detail if failing is not None else "量比未落在设定区间"

    return Evaluation(
        complete_data=complete_data,
        listed_long_enough=listed_long_enough,
        pct_chg_in_range=pct_chg_in_range,
        volume_doubled=volume_doubled,
        reason=reason,
        detail=detail,
        first_volume_ratio=first_ratio,
        second_volume_ratio=second_ratio,
    )


def _fmt_pct(bar: DailyBar | None) -> str:
    if bar is None or bar.pct_chg is None:
        return "-"
    return f"{bar.pct_chg}%"


def format_ratio_interval(criteria: ScreenCriteria, *, first: bool) -> str:
    """第一次 / 第二次量比的区间文本。"""

    if first:
        low = criteria.first_volume_ratio_min
        high = criteria.first_volume_ratio_max
        inclusive = criteria.first_volume_ratio_inclusive
    else:
        low = criteria.second_volume_ratio_min
        high = criteria.second_volume_ratio_max
        inclusive = criteria.second_volume_ratio_inclusive
    return format_interval(low, high, inclusive, unit=" 倍")


def format_pct_interval(criteria: ScreenCriteria) -> str:
    """涨跌幅区间的区间文本 (带正负号, 便于区分涨幅与跌幅)。"""

    return format_interval(
        criteria.pct_chg_min,
        criteria.pct_chg_max,
        criteria.pct_chg_inclusive,
        unit="%",
        signed=True,
    )


def rule_description(criteria: ScreenCriteria = DEFAULT_CRITERIA) -> dict[str, str]:
    """返回人类可读的规则说明, 供前端展示 ([ ] 表示含边界, ( ) 表示不含)。"""

    return {
        "volume_ratio": (
            f"D1成交量 / D0成交量 {format_ratio_interval(criteria, first=True)}"
            f" 且 D2成交量 / D1成交量 {format_ratio_interval(criteria, first=False)}"
        ),
        "pct_chg": (
            f"三日涨跌幅 (D0 / D1 / D2) 均落在 {format_pct_interval(criteria)}"
            " (负值 = 跌幅, 正值 = 涨幅)"
        ),
        "st": (
            "D2 简称不含 ST / *ST"
            if criteria.exclude_st
            else "不排除 ST / *ST 股票"
        ),
        "newly_listed": (
            "上市时间满三个交易日 (非次新股)"
            if criteria.exclude_newly_listed
            else "不排除次新股"
        ),
        "completeness": "D0、D1、D2 三天均有正常交易的完整行情数据",
    }


def rejection_label(reason: RejectionReason, criteria: ScreenCriteria) -> str:
    """带当前参数的未通过原因标签 (阈值改了, 标签跟着变)。"""

    if reason is RejectionReason.PCT_CHG_OUT_OF_RANGE:
        return f"三日涨跌幅未全部落在 {format_pct_interval(criteria)}"
    if reason is RejectionReason.VOLUME_RATIO_TOO_LOW:
        return f"量比未落在区间内 {format_ratio_interval(criteria, first=True)}"
    return reason.label
