"""构造整套策略的联合示例，并使用实际条件引擎验算后返回。"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal, ROUND_CEILING, ROUND_FLOOR
from math import exp, isfinite, log

from app.domain.conditions import ConditionSpec, ScreenContext, evaluate_condition, validate_conditions
from app.domain.enums import Board, Exchange
from app.domain.models import DailyBar, ScreenCandidate, ScreenWindow, StockInfo
from app.domain.rules import is_st_name


@dataclass
class _Range:
    metric: str
    left: int | None
    right: int
    low: Decimal | None
    high: Decimal | None
    low_closed: bool
    high_closed: bool
    sources: set[int]


def _merge(ranges: list[_Range]) -> tuple[list[_Range], list[int]]:
    merged: dict[tuple, _Range] = {}
    for item in ranges:
        key = (item.metric, item.left, item.right)
        if key not in merged:
            merged[key] = item
        else:
            current = merged[key]
            if item.low is not None:
                if current.low is None or item.low > current.low:
                    current.low, current.low_closed = item.low, item.low_closed
                elif item.low == current.low:
                    current.low_closed &= item.low_closed
            if item.high is not None:
                if current.high is None or item.high < current.high:
                    current.high, current.high_closed = item.high, item.high_closed
                elif item.high == current.high:
                    current.high_closed &= item.high_closed
            current.sources |= item.sources
        current = merged[key]
        if current.low is not None and current.high is not None:
            if current.low > current.high or (current.low == current.high and not (current.low_closed and current.high_closed)):
                return [], sorted(current.sources)
    return list(merged.values()), []


def _solve(ranges: list[_Range], first: int, last: int, margin: float) -> dict[int, float] | None:
    """log(数值) 的差分约束；包含收盘价的绝对约束时使用同一零点。"""
    anchor = last + 1
    nodes = list(range(first, last + 2))
    edges = []
    for item in ranges:
        left = anchor if item.left is None else item.left
        lo = log(float(item.low)) if item.low is not None and item.low > 0 else None
        hi = log(float(item.high)) if item.high is not None else None
        slack = min(margin, (hi - lo) / 4) if lo is not None and hi is not None else margin
        if hi is not None:
            edges.append((left, item.right, hi - slack))
        if lo is not None:
            edges.append((item.right, left, -lo - slack))

    def potentials(extra=()):
        values = dict.fromkeys(nodes, 0.0)
        all_edges = [*edges, *extra]
        for _ in nodes:
            changed = False
            for left, right, bound in all_edges:
                candidate = values[left] + bound
                if values[right] > candidate + 1e-12:
                    values[right] = candidate
                    changed = True
            if not changed:
                return values
        return None

    values = potentials()
    if values is None:
        return None
    # 选取可行区间内部的值，避免把开区间边界误画为满足。
    preferred = []
    for item in ranges:
        low, high = item.low, item.high
        target = (low + high) / 2 if low is not None and high is not None else low * Decimal("1.2") if low is not None and low > 0 else high * Decimal("0.8") if high is not None else Decimal(1)
        if target <= 0:
            continue
        left = anchor if item.left is None else item.left
        weight = log(float(target))
        trial = [*preferred, (left, item.right, weight), (item.right, left, -weight)]
        result = potentials(trial)
        if result is not None:
            preferred, values = trial, result
    shift = values[anchor] if any(item.left is None for item in ranges) else values[0] - log(20)
    result = {node: values[node] - shift for node in range(first, last + 1)}
    fixed = sorted({node for item in ranges for node in (item.left, item.right) if node is not None})
    # 未受约束的日期平滑连接相邻约束点，不额外制造策略没有要求的跳空。
    for node in result:
        if node in fixed or not fixed:
            continue
        before = max((point for point in fixed if point < node), default=fixed[0])
        after = min((point for point in fixed if point > node), default=fixed[-1])
        result[node] = result[before] if before == after else result[before] + (result[after] - result[before]) * (node - before) / (after - before)
    return result


def build_strategy_preview(conditions: tuple[ConditionSpec, ...]) -> dict:
    specs = validate_conditions(conditions)
    if not specs:
        return {"status": "empty", "bars": [], "checks": [], "conflicts": []}
    ranges = []
    first, last = -4, 2
    for index, spec in enumerate(specs):
        kind = spec.kind
        if kind in {"listed_min_days", "not_st"}:
            if kind == "not_st":
                first, last = min(first, spec.integer("offset")), max(last, spec.integer("offset"))
            continue
        end = spec.integer("offset")
        span = max(1, spec.integer("span", 3)) if kind in {"pct_chg_range", "cumulative_pct_chg_range"} else 1
        start = end - span + 1
        first, last = min(first, start - 1), max(last, end)
        low, high, closed = spec.number("min"), spec.number("max"), spec.flag("inclusive")
        low_closed = high_closed = closed
        if kind == "cumulative_pct_chg_range":
            quantum = Decimal(".0001")
            if low is not None:
                grid = (low / quantum).to_integral_value(rounding=ROUND_CEILING)
                if not closed and grid * quantum == low:
                    grid += 1
                low, low_closed = (grid - Decimal(".5")) * quantum, grid % 2 == 0
            if high is not None:
                grid = (high / quantum).to_integral_value(rounding=ROUND_FLOOR)
                if not closed and grid * quantum == high:
                    grid -= 1
                high, high_closed = (grid + Decimal(".5")) * quantum, grid % 2 == 0
        if kind in {"pct_chg_range", "cumulative_pct_chg_range"}:
            low = None if low is None else 1 + low / 100
            high = None if high is None else 1 + high / 100
        metric = "volume" if kind == "volume_ratio_range" else "amount" if kind == "amount_range" else "price"
        pairs = [(node - 1, node) for node in range(start, end + 1)] if kind == "pct_chg_range" else [(start - 1, end)] if kind == "cumulative_pct_chg_range" else [(end - 1, end)] if kind == "volume_ratio_range" else [(None, end)]
        for left, right in pairs:
            floor = Decimal(0)
            actual_low = max(floor, low) if low is not None else floor
            floor_closed = metric == "amount"
            ranges.append(_Range(metric, left, right, actual_low, high, low_closed if low is not None and low > 0 else floor_closed and (low is None or low_closed), high_closed, {index}))
    ranges, conflicts = _merge(ranges)
    if conflicts:
        return {"status": "conflict", "bars": [], "checks": [], "conflicts": conflicts, "message": "这些条件的区间没有共同取值，无法同时满足。"}
    prices = [item for item in ranges if item.metric == "price"]
    volumes = [item for item in ranges if item.metric == "volume"]
    amounts = {item.right: item for item in ranges if item.metric == "amount"}
    nodes = {node: date(2026, 1, 1) + timedelta(days=node) for node in range(first - 1, last + 1)}
    window = ScreenWindow(nodes[0], nodes[-2], nodes[-1], nodes[0], nodes=nodes)
    listed_days = max((max(1, spec.integer("days", 3)) for spec in specs if spec.kind == "listed_min_days"), default=0)
    stock = StockInfo("sh.600000", Exchange.SH, "600000", "示例股份", Board.MAIN_SH, listing_date=nodes[0] - timedelta(days=listed_days + 1))
    context = ScreenContext(window, {days: nodes[0] - timedelta(days=days) for days in range(1, listed_days + 1)})
    for margin in (1e-6, 1e-10, 0):
        p = _solve(prices, first - 1, last, margin)
        v = _solve(volumes, first - 1, last, margin)
        if p is None or v is None:
            continue
        try:
            closes = {node: Decimal(f"{exp(value):.12g}") for node, value in p.items()}
            minimum_volume = min(v.values())
            bars = {}
            for node in range(first, last + 1):
                close, previous = closes[node], closes[node - 1]
                volume = max(1, round(exp(v[node] - minimum_volume) * 10**6))
                amount_range = amounts.get(node)
                amount = close * Decimal(volume) / 10000
                if amount_range:
                    low, high = amount_range.low, amount_range.high
                    amount = (low + high) / 2 if high is not None else max(low * Decimal("1.2"), Decimal(5000))
                bars[nodes[node]] = DailyBar(stock.code, nodes[node], close, previous, max(close, previous) * Decimal("1.008"), min(close, previous) * Decimal(".992"), previous, volume, amount * 10000, pct_chg=((close / previous - 1) * 100).quantize(Decimal(".00000001")))
            candidate = ScreenCandidate(stock, "示例股份", bars)
            checks = []
            for index, spec in enumerate(specs):
                if spec.kind == "not_st":
                    checks.append({"index": index, "passed": not is_st_name(candidate.name_at_d2), "detail": f"{spec.label().removeprefix('且')}（示例历史简称：示例股份）"})
                else:
                    result = evaluate_condition(spec, candidate, context)
                    detail = f"示例上市已满 {listed_days} 个交易日" if spec.kind == "listed_min_days" else result.detail
                    checks.append({"index": index, "passed": result.passed, "detail": detail})
            if all(item["passed"] for item in checks):
                output = [{"offset": node, **{key: float(getattr(bars[nodes[node]], key)) for key in ("open", "close", "high", "low", "pct_chg", "volume")}, "amount": float(bars[nodes[node]].amount / 10000)} for node in range(first, last + 1)]
                if all(isfinite(value) for bar in output for value in bar.values()):
                    return {"status": "ok", "bars": output, "checks": checks, "conflicts": [], "listed_days": listed_days, "message": f"{len(specs)} 条条件已在同一组示例中全部通过校验。"}
        except (OverflowError, ArithmeticError, ValueError):
            continue
    return {"status": "unavailable", "bars": [], "checks": [], "conflicts": [], "message": "暂未找到通过全部条件校验的组合示例；可能存在跨日期冲突或数值精度限制。"}
