"""筛选服务: 组合规则层、ST 策略与仓储, 产出筛选结果。"""

from __future__ import annotations

import logging
from calendar import monthrange
from collections import Counter
from dataclasses import replace
from datetime import UTC, date, datetime
from decimal import Decimal

from app.core.errors import DataNotAvailableError, FindStockError, InvalidRequestError
from app.domain.conditions import (
    CONDITION_REASONS,
    DEFAULT_STRATEGY,
    ConditionSpec,
    ScreenContext,
    ScreenStrategy,
    bar_problems,
    evaluate_condition,
    required_listing_days,
    strategy_from_criteria,
    used_offsets,
)
from app.domain.enums import Exchange, RejectionReason, StBasis
from app.domain.models import (
    DailyBar,
    FunnelCounts,
    FunnelStage,
    MonthScanResult,
    ScanDayResult,
    ScreenCandidate,
    ScreenHit,
    ScreenResult,
    StockInfo,
    node_symbol,
)
from app.domain.rules import (
    ScreenCriteria,
    compute_volume_ratio,
    rejection_label,
)
from app.domain.st_policy import StDecision, decide_st
from app.domain.symbols import detect_board
from app.repositories.bar_repository import BarRepository
from app.repositories.stock_repository import StockRepository
from app.repositories.sync_repository import SyncRepository
from app.services.calendar_service import TradingCalendarService
from app.services.name_history_service import NameHistoryService

logger = logging.getLogger(__name__)

#: 若某交易日行情条数低于三天中位数的该比例, 认为数据可能不完整并给出提示。
_INCOMPLETE_DAY_RATIO = 0.95


class ScreenerService:
    """执行 "三日量价齐升" 筛选。"""

    def __init__(
        self,
        calendar_service: TradingCalendarService,
        bar_repository: BarRepository,
        stock_repository: StockRepository,
        sync_repository: SyncRepository,
        name_history_service: NameHistoryService,
    ) -> None:
        self._calendar = calendar_service
        self._bars = bar_repository
        self._stocks = stock_repository
        self._sync = sync_repository
        self._name_history = name_history_service

    def screen(
        self,
        selected_date: date,
        criteria: ScreenCriteria | None = None,
        strategy: ScreenStrategy | None = None,
    ) -> ScreenResult:
        """按用户选择的日期与选股策略执行筛选。

        传 ``criteria`` 时按"标准规则参数"筛选 (等价于内置标准策略),
        传 ``strategy`` 时按策略里的条件模块逐条筛选。
        """

        if criteria is not None:
            strategy = strategy_from_criteria(criteria)
        strategy = strategy or DEFAULT_STRATEGY

        window = self._calendar.resolve_window(selected_date)
        window = self._expand_window(window, strategy)
        # 节点落在本地交易日历之外 (例如基准日已在日历末尾却要求 T+3) 时直接说明,
        # 否则每个条件都会因为"没有这根 K 线"而失败, 用户只会看到 0 结果。
        out_of_range = [
            node_symbol(offset)
            for offset in sorted(used_offsets(strategy.conditions))
            if window.date_at(offset) is None
        ]
        if out_of_range:
            raise InvalidRequestError(
                f"策略用到的 {'、'.join(out_of_range)} 超出了本地交易日历范围 "
                f"(基准日 {selected_date.isoformat()} 太靠近日历末尾): "
                "请改用更早的基准日, 或先补充交易日历。"
            )
        days = sorted(set(window.nodes.values()))
        self._ensure_data_available(tuple(days), window)

        bars_by_code = self._bars.load_bars_for_dates(days)
        stocks = self._stocks.list_all()
        names_at_d2 = self._stocks.names_on(window.anchor)
        snapshot_available = self._stocks.has_names_on(window.anchor)

        candidates = self._build_candidates(bars_by_code, stocks, names_at_d2)
        context = self._build_context(window, strategy)

        # 第一级: 候选集; 第二级: 三天行情完整 (任何策略都需要, 否则无从判断)。
        alive: list[ScreenCandidate] = []
        problems: dict[str, str] = {}
        for candidate in candidates:
            issue = bar_problems(candidate, window)
            if issue:
                problems[candidate.stock.code] = "; ".join(issue)
            else:
                alive.append(candidate)

        stages: list[FunnelStage] = [
            FunnelStage(
                key="universe",
                label="候选股票 (三个交易日中出现过的沪深A股)",
                count=len(candidates),
                kind="universe",
            ),
            FunnelStage(
                key="complete_data",
                label="且 T-2 / T-1 / T0 三天数据完整、均正常交易",
                count=len(alive),
                kind="complete_data",
            ),
        ]
        rejections: Counter[str] = Counter()
        if problems:
            rejections[_rejection_label_for("complete_data", None, criteria)] += len(problems)

        # 逐条条件收窄。
        #
        # 实现细节: "排除 ST" 需要额外的历史简称 (没有 T0 简称快照时要联网抓),
        # 因此始终放到最后计算 —— 否则把它写在第一条会让系统对全市场 5000+ 只
        # 股票逐个抓简称, 一次筛选要几十秒。其余条件严格按用户设定的顺序执行。
        data_conditions = [item for item in strategy.conditions if item.kind != "not_st"]
        st_conditions = [item for item in strategy.conditions if item.kind == "not_st"]
        decisions: dict[str, StDecision] = {}
        snapshot_days: dict[date, bool] = {window.anchor: snapshot_available}
        for index, spec in enumerate(data_conditions + st_conditions):
            survivors: list[ScreenCandidate] = []
            for candidate in alive:
                code = candidate.stock.code
                if spec.kind == "not_st":
                    st_day = window.date_at(spec.integer("offset", 0)) or window.anchor
                    if st_day not in snapshot_days:
                        snapshot_days[st_day] = self._stocks.has_names_on(st_day)
                    decision = decisions.get(code)
                    if decision is None:
                        decision = self._decide_st(
                            candidate, st_day, snapshot_days[st_day]
                        )
                        decisions[code] = decision
                    passed = not decision.is_st
                else:
                    passed = evaluate_condition(spec, candidate, context).passed
                if passed:
                    survivors.append(candidate)
                else:
                    rejections[_rejection_label_for(spec.kind, spec, criteria)] += 1
            alive = survivors
            stages.append(
                FunnelStage(
                    key=f"{spec.kind}-{index}",
                    label=spec.label(),
                    count=len(alive),
                    kind=spec.kind,
                )
            )

        hits = self._collect_hits(alive, decisions, window.dates)

        return ScreenResult(
            selected_date=selected_date,
            window=window,
            hits=tuple(hits),
            funnel=_build_funnel(stages),
            rejection_counts=dict(rejections),
            warnings=self._build_warnings(window.dates, snapshot_available, hits),
            criteria=criteria,
            strategy=strategy,
            generated_at=datetime.now(UTC),
        )

    def scan_month(
        self,
        month: str,
        criteria: ScreenCriteria | None = None,
        strategy: ScreenStrategy | None = None,
    ) -> MonthScanResult:
        """把基准日 T0 遍历一个月的每个交易日, 汇总所有命中的股票。

        ``month`` 形如 ``2026-09``。某些交易日可能因为数据没下载完而跳过,
        这些天会在 ``days`` 里标记出来 (不静默丢失)。
        """

        year, mon = (int(part) for part in str(month).split("-", 1))
        first = date(year, mon, 1)
        last = date(year, mon, monthrange(year, mon)[1])
        trading_days = self._calendar.open_days(first, last)

        days: list[ScanDayResult] = []
        hits: list[tuple[date, ScreenHit]] = []
        for day in trading_days:
            try:
                result = self.screen(day, criteria=criteria, strategy=strategy)
            except FindStockError as exc:
                # 某一天跑不了 (数据不全 / 历史不足 / 参数越界) 只跳过这一天,
                # 其余交易日继续扫描, 并在结果里说明原因。
                days.append(
                    ScanDayResult(day=day, skipped=True, reason=str(exc.message))
                )
                continue
            days.append(ScanDayResult(day=day, hit_count=result.hit_count))
            hits.extend((day, hit) for hit in result.hits)

        return MonthScanResult(month=f"{year:04d}-{mon:02d}", days=tuple(days), hits=tuple(hits))

    # --- 内部实现 ---------------------------------------------------------

    def _build_context(self, window, strategy: ScreenStrategy) -> ScreenContext:
        """按策略需要预计算上下文 (目前只有"上市满 N 个交易日"需要日历)。"""

        days = required_listing_days(strategy.conditions)
        ago: dict[int, date | None] = {}
        if days:
            recent = self._calendar.recent_open_days(window.d2, days + 1)
            ago[days] = recent[-1] if recent and len(recent) > days else (
                window.previous_trading_day
            )
        return ScreenContext(window=window, trading_days_ago=ago)

    def _expand_window(self, window, strategy: ScreenStrategy):
        """按策略用到的时间节点补全 window.nodes (T-4 及更早 / T+1 及以后)。"""

        offsets = used_offsets(strategy.conditions)
        wanted = sorted(offsets)
        earliest = min(wanted)
        latest = max(wanted)
        nodes: dict[int, date] = dict(window.nodes)
        nodes.update({0: window.d2, -1: window.d1, -2: window.d0})
        if window.previous_trading_day is not None:
            nodes[-3] = window.previous_trading_day

        if earliest < -3:
            # 再往前翻 (取足够多的交易日, 由近到远)
            recent = self._calendar.recent_open_days(window.d2, abs(earliest) + 1)
            nodes.update({-index: day for index, day in enumerate(recent)})
        if latest > 0:
            future = self._calendar.following_open_days(window.d2, latest)
            nodes.update(dict(enumerate(future, start=1)))

        usable = {offset: day for offset, day in nodes.items() if offset in offsets}
        return replace(window, nodes=usable)

    def _ensure_data_available(self, dates: tuple[date, ...], window) -> None:
        """确认策略用到的每个时间节点都有完整行情。

        报错时要说清楚"是哪个节点 (T+1 等) 没有数据", 并给出一个能马上出结果的
        基准日建议 —— 否则用户只会看到"没有结果", 不知道是数据问题。
        """

        synced = self._sync.synced_days()
        missing = tuple(day for day in dates if day not in synced)
        if not missing:
            return

        counts = self._bars.covers_dates(list(missing))
        offset_by_day = {day: offset for offset, day in window.nodes.items()}
        described = "、".join(
            f"{node_symbol(offset_by_day[day])} ({day.isoformat()}"
            + (
                f", 本地仅 {counts.get(day, 0)} 只股票有行情"
                if counts.get(day)
                else ", 本地没有该日行情"
            )
            + ")"
            for day in missing
        )
        raise DataNotAvailableError(
            f"策略用到的 {described} 还没有完整下载, 无法在该时间节点上判定。"
            "请先更新数据, 或改用有完整数据的基准日。",
            missing_dates=missing,
            required_dates=tuple(dates),
            suggested_date=self._suggest_anchor(window, synced),
        )

    def _suggest_anchor(self, window, synced: set[date]) -> date | None:
        """找一个"所有节点都有完整行情"的基准日 (从当前基准日往前找)。"""

        offsets = tuple(window.nodes)
        if not offsets:
            return self._calendar.latest_complete_trading_day()
        back = abs(min(offsets)) + 1
        forward = max(max(offsets), 0)
        for shift in range(1, 16):
            recent = self._calendar.recent_open_days(window.anchor, back + shift)
            if len(recent) <= shift:
                break
            anchor = recent[shift]
            nodes = {0: anchor}
            nodes.update({-index: day for index, day in enumerate(recent[shift:])})
            if forward:
                future = self._calendar.following_open_days(anchor, forward)
                nodes.update(dict(enumerate(future, start=1)))
            if all(nodes.get(offset) in synced for offset in offsets):
                return anchor
        return self._calendar.latest_complete_trading_day()

    def _build_candidates(
        self,
        bars_by_code: dict[str, dict[date, DailyBar]],
        stocks: dict[str, StockInfo],
        names_at_d2: dict[str, str],
    ) -> list[ScreenCandidate]:
        """构造候选股票集合 (三个交易日中至少出现一天的沪深A股)。"""

        candidates: list[ScreenCandidate] = []
        for code, bar_map in bars_by_code.items():
            stock = stocks.get(code) or _fallback_stock(code)
            candidates.append(
                ScreenCandidate(
                    stock=stock,
                    name_at_d2=names_at_d2.get(code) or stock.name,
                    bars=bar_map,
                )
            )
        candidates.sort(key=lambda candidate: candidate.stock.code)
        return candidates

    def _decide_st(
        self, candidate: ScreenCandidate, d2: date, snapshot_available: bool
    ) -> StDecision:
        """对单只候选股票做 ST 判定。"""

        bar = candidate.bars.get(d2)
        history: tuple[str, ...] = (
            ()
            if snapshot_available
            else tuple(self._name_history.history_for(candidate.stock.code))
        )
        return decide_st(
            board=candidate.stock.board,
            name_at_d2=candidate.name_at_d2,
            snapshot_available=snapshot_available,
            name_history=history,
            current_name=candidate.stock.name,
            pct_chg_at_d2=None if bar is None else bar.pct_chg,
        )

    def _collect_hits(
        self,
        passing: list[ScreenCandidate],
        decisions: dict[str, StDecision],
        dates: tuple[date, date, date],
    ) -> list[ScreenHit]:
        hits: list[ScreenHit] = []
        for candidate in passing:
            decision = decisions.get(candidate.stock.code)
            if decision is not None and decision.is_st:
                continue
            bars = tuple(candidate.bars[day] for day in dates)
            first_ratio = _ratio(bars[1].volume, bars[0].volume)
            second_ratio = _ratio(bars[2].volume, bars[1].volume)
            hits.append(
                ScreenHit(
                    code=candidate.stock.code,
                    name=candidate.name_at_d2 or candidate.stock.display_name,
                    board=candidate.stock.board,
                    bars=bars,  # type: ignore[arg-type]
                    first_volume_ratio=first_ratio,
                    second_volume_ratio=second_ratio,
                    st_basis=decision.basis if decision else StBasis.CURRENT_NAME,
                    st_detail=(
                        decision.detail
                        if decision
                        else "本次筛选未排除 ST 股票, 未做 ST 判定"
                    ),
                    st_exact=False if decision is None else decision.exact,
                )
            )
        # 量能放大最显著的排在最前, 便于快速阅读。
        hits.sort(key=lambda hit: (-hit.second_volume_ratio, hit.code))
        return hits

    def _build_warnings(
        self,
        dates: tuple[date, date, date],
        snapshot_available: bool,
        hits: list[ScreenHit],
    ) -> tuple[str, ...]:
        """数据完整性与 ST 判定口径提示。"""

        warnings: list[str] = []

        counts = self._bars.covers_dates(list(dates))
        values = [counts.get(day, 0) for day in dates]
        reference = sorted(values)[len(values) // 2]
        for day, count in zip(dates, values, strict=True):
            if reference > 0 and count < reference * _INCOMPLETE_DAY_RATIO:
                warnings.append(
                    f"{day.isoformat()} 的行情条数 ({count}) 明显少于其他交易日, "
                    "该日数据可能不完整, 建议重新执行数据更新。"
                )

        if not snapshot_available:
            warnings.append(
                f"本地没有 {dates[2].isoformat()} 当天的股票简称快照, "
                "ST 判定改用历史简称序列 + 涨跌幅上限推断 (每条结果都标注了依据)。"
            )
            inferred = sorted(
                {hit.st_basis.label for hit in hits if not hit.st_exact}
            )
            if inferred:
                warnings.append(
                    "部分命中的 ST 判定不是精确口径, 建议人工复核: "
                    + "、".join(inferred)
                )
        return tuple(warnings)


def _fallback_stock(code: str) -> StockInfo:
    """当股票不在基础信息表中时的兜底对象。"""

    exchange, symbol = code.split(".", 1)
    return StockInfo(
        code=code,
        exchange=Exchange(exchange),
        symbol=symbol,
        name=None,
        board=detect_board(code),
    )


def _ratio(current: int | None, previous: int | None) -> Decimal:
    """量比 (仅用于展示); 分母缺失或为 0 时按 0 处理。"""

    if not current or not previous:
        return Decimal(0)
    return compute_volume_ratio(current, previous)


def _build_funnel(stages: list[FunnelStage]) -> FunnelCounts:
    """由"逐条条件的通过数"构建漏斗计数。"""

    counts = {stage.kind: stage.count for stage in stages if stage.kind}
    complete = counts.get("complete_data", 0)
    # 旧字段 (标准策略的可读性更好): 缺失的条件沿用上一级数量
    listed = counts.get("listed_min_days", complete)
    pct = counts.get("pct_chg_range", listed)
    volume = counts.get("volume_ratio_range", pct)
    not_st = counts.get("not_st", volume)
    return FunnelCounts(
        universe=counts.get("universe", 0),
        complete_data=complete,
        stages=tuple(stages),
        listed_long_enough=listed,
        pct_chg_in_range=pct,
        volume_doubled=volume,
        not_st=not_st,
    )


def _rejection_label_for(
    kind: str,
    spec: ConditionSpec | None,
    criteria: ScreenCriteria | None,
) -> str:
    """未通过原因的中文标签。

    * 走"标准参数"接口时沿用旧的措辞 (与历史结果一致);
    * 走策略接口时直接用条件描述, 方便看清是哪条条件被挡住。
    """

    if kind == "complete_data":
        return RejectionReason.INCOMPLETE_DATA.label
    reason_code = CONDITION_REASONS.get(kind)
    if criteria is not None and reason_code is not None:
        try:
            return rejection_label(RejectionReason(reason_code), criteria)
        except ValueError:  # pragma: no cover - 防御性
            pass
    if spec is not None:
        return f"未通过: {spec.summary()}"
    return "未通过: 其他条件"


def rejection_label_counts(result: ScreenResult) -> dict[str, int]:
    """未通过原因 → 数量 (按数量降序), 直接给前端展示。"""

    return dict(
        sorted(result.rejection_counts.items(), key=lambda item: (-item[1], item[0]))
    )
