"""数据同步引擎。

职责: 把数据源抓取、落库、进度上报串起来, 形成可恢复的后台任务。

三种模式:

``full``
    首次全量下载: 交易日历 + 股票列表 + 最近 N 年全部日线行情。
``incremental``
    增量更新: 补充新交易日和本地覆盖区间内尚未完成的交易日。
``targeted``
    按需补数: 只下载指定日期 (例如用户选择的 D0/D1/D2)。

所有模式都以股票为单位抓取, 以交易日为单位记账 (``synced_day``),
并且在 ``stock.last_sync_end`` 上记录每只股票的进度, 因此失败后重跑
不会重复下载已完成的数据。
"""

from __future__ import annotations

import contextlib
import json
import logging
import math
from collections.abc import Callable, Sequence
from dataclasses import dataclass, replace
from datetime import UTC, date, datetime, timedelta
from datetime import time as clock_time

from pydantic import TypeAdapter, ValidationError

from app.core.config import Settings
from app.core.errors import FindStockError
from app.domain.enums import SyncMode, SyncStatus, TradeStatus
from app.domain.models import DailyBar, StockInfo
from app.domain.symbols import detect_board, split_code
from app.providers import create_provider
from app.providers.base import MarketDataProvider
from app.providers.bulk_fetcher import BulkFetcher
from app.repositories.bar_repository import BarRepository
from app.repositories.calendar_repository import CalendarRepository
from app.repositories.database import Database
from app.repositories.meta_repository import MetaRepository
from app.repositories.stock_repository import StockRepository
from app.repositories.sync_repository import SyncRepository
from app.services.ladder_service import HISTORY_DAYS, MARKET_TIMEZONE, LadderService

logger = logging.getLogger(__name__)

_CALENDAR_PADDING_DAYS = 10
_INCREMENTAL_LOOKBACK_DAYS = 90
_LADDER_PENDING_KEY = "ladder_sync_pending_dates:v1"
_LADDER_DATES = TypeAdapter(list[date])

#: A 股收盘时间。当天收盘前行情还不完整, 不能算作 "最新可用交易日",
#: 否则盘中执行更新会把半天数据当成完整的一天记进 synced_day。
_MARKET_CLOSE = clock_time(15, 30)


class SyncCancelledError(Exception):
    """同步任务被用户取消。"""


@dataclass(frozen=True, slots=True)
class SyncPlan:
    """一次同步的执行计划。"""

    mode: SyncMode
    fetch_start: date
    fetch_end: date
    fetch_dates: tuple[date, ...]
    codes: tuple[str, ...]
    latest_trading_day: date
    history_start: date


class SyncEngine:
    """执行数据同步。"""

    def __init__(
        self,
        settings: Settings,
        database: Database,
        *,
        calendar_repository: CalendarRepository,
        stock_repository: StockRepository,
        bar_repository: BarRepository,
        sync_repository: SyncRepository,
        meta_repository: MetaRepository,
        provider_factory: Callable[[], MarketDataProvider] | None = None,
    ) -> None:
        self._settings = settings
        self._db = database
        self._calendar = calendar_repository
        self._stocks = stock_repository
        self._bars = bar_repository
        self._sync = sync_repository
        self._meta = meta_repository
        self._provider_factory = provider_factory or (
            lambda: create_provider(
                settings.provider,
                timeout=settings.request_timeout,
                max_attempts=settings.request_retries,
            )
        )
        self._suspensions: dict[date, set[str]] = {}
        self._listing_checked = False
        self._delisting_checked = False

    # --- 对外入口 ---------------------------------------------------------

    def run(
        self,
        mode: SyncMode,
        run_id: str,
        *,
        target_dates: Sequence[date] | None = None,
    ) -> None:
        """执行同步; 所有异常都会被记录到任务状态中。"""

        self._sync.update(run_id, phase="preparing", message="正在准备同步任务")
        self._suspensions.clear()
        self._listing_checked = False
        self._delisting_checked = False
        provider = None
        try:
            provider = self._provider_factory()
            provider.open()
            plan = self._build_plan(provider, mode, run_id, target_dates)
            ladder_message, ladder_warning = self._sync_ladder(provider, run_id, plan)
            _raise_if_cancelled(self._sync, run_id)
            # 悟道按页独立记账；题材缺失不阻止已有行情的校验与保存。
            from app.services.wudao_theme_service import WudaoThemeService

            themes = WudaoThemeService(self._settings, self._db)
            if themes.status()["configured"]:
                self._sync.update(run_id, phase="themes", message="正在批量下载悟道题材")
                try:
                    theme_status = themes.synchronize(check_cancelled=lambda: _raise_if_cancelled(self._sync, run_id))
                    ladder_message += " " + theme_status["message"]
                    if theme_status["error"]:
                        ladder_warning = " ".join(filter(None, [ladder_warning, theme_status["error"]]))
                except FindStockError as exc:
                    ladder_message += " 悟道题材未完成: " + str(exc)
            _raise_if_cancelled(self._sync, run_id)
            failures = self._download(provider, run_id, plan) if plan.fetch_dates else {}
            verification = self._finalize(provider, run_id, plan, failures)
            _raise_if_cancelled(self._sync, run_id)
            message = self._success_message(plan) if plan.fetch_dates else "本地日线已是最新, 无需重复下载。"
            message += verification + ladder_message
            self._sync.finish(run_id, SyncStatus.SUCCEEDED, message=message, error=ladder_warning)
            logger.info("同步任务 %s 完成: %s", run_id, message)
        except SyncCancelledError:
            logger.info("同步任务 %s 已被取消", run_id)
            self._sync.finish(run_id, SyncStatus.CANCELLED, message="任务已被用户取消。")
        except Exception as exc:  # noqa: BLE001 - 任务级兜底, 需要写回状态
            logger.exception("同步任务 %s 失败", run_id)
            self._sync.finish(
                run_id, SyncStatus.FAILED, error=f"{type(exc).__name__}: {exc}"
            )
            raise
        finally:
            with contextlib.suppress(Exception):
                if provider is not None:
                    provider.close()

    # --- 计划阶段 ---------------------------------------------------------

    def _build_plan(
        self,
        provider: MarketDataProvider,
        mode: SyncMode,
        run_id: str,
        target_dates: Sequence[date] | None,
    ) -> SyncPlan:
        now = datetime.now(MARKET_TIMEZONE)
        today = now.date()
        usable_until = latest_usable_day(now)
        history_start = today - timedelta(days=365 * self._settings.history_years + 30)

        targets = tuple(sorted(set(target_dates or ())))
        calendar_start = history_start
        if targets:
            calendar_start = min(
                calendar_start, min(targets) - timedelta(days=_CALENDAR_PADDING_DAYS)
            )

        self._sync.update(run_id, phase="calendar", message="正在更新交易日历")
        days = provider.fetch_trading_calendar(calendar_start, today)
        with self._db.session() as conn:
            self._calendar.upsert_days(conn, days)

        # 数据源的日历可能包含未来的交易日, 必须按 "今天且已收盘" 截断,
        # 否则会把还没发生、或还没走完的日期当成最新交易日。
        open_days = sorted({day for day, is_open in days if is_open and day <= usable_until})
        if not open_days:
            raise RuntimeError("交易日历为空, 无法继续")
        latest_trading_day = max(open_days)
        if mode is SyncMode.TARGETED and (not targets or set(targets) - set(open_days)):
            raise ValueError("按需补数只能选择已经收盘的交易日")

        codes = self._refresh_universe(provider, run_id, latest_trading_day)
        fetch_dates = self._resolve_fetch_dates(mode, latest_trading_day, targets, open_days)

        if not fetch_dates:
            return SyncPlan(
                mode=mode,
                fetch_start=latest_trading_day,
                fetch_end=latest_trading_day,
                fetch_dates=(),
                codes=codes,
                latest_trading_day=latest_trading_day,
                history_start=history_start,
            )

        fetch_start, fetch_end = fetch_dates[0], fetch_dates[-1]

        pending_note = ""
        if mode is SyncMode.FULL:
            pending = self._stocks.codes_needing_sync(fetch_end)
            if len(pending) < len(codes):
                pending_note = f", 已跳过 {len(codes) - len(pending)} 只已下载的股票"
            codes = tuple(pending)

        stocks = self._stocks.list_all()
        codes = tuple(code for code in codes
                      if stocks[code].out_date is None or fetch_start < stocks[code].out_date)

        self._sync.update(
            run_id,
            total_stocks=len(codes),
            total_days=len(fetch_dates),
            message=(
                f"待下载 {len(codes)} 只股票 × {len(fetch_dates)} 个交易日 "
                f"({fetch_start.isoformat()} ~ {fetch_end.isoformat()}){pending_note}"
            ),
        )
        return SyncPlan(
            mode=mode,
            fetch_start=fetch_start,
            fetch_end=fetch_end,
            fetch_dates=tuple(fetch_dates),
            codes=codes,
            latest_trading_day=latest_trading_day,
            history_start=history_start,
        )

    def _refresh_universe(
        self, provider: MarketDataProvider, run_id: str, latest_trading_day: date
    ) -> tuple[str, ...]:
        """刷新股票列表与当日简称, 返回需要抓取行情的代码列表。

        akshare 只能提供 **当前** 简称, 因此快照一律记在实际取数的
        ``latest_trading_day`` 上; 历史日期没有当日简称快照时, 由
        :mod:`app.domain.st_policy` 用历史简称 + 涨跌幅上限推断。
        """

        if self._stocks.has_names_on(latest_trading_day) and self._stocks.count() > 0:
            self._sync.update(
                run_id, phase="universe", message="股票列表已是最新, 跳过下载"
            )
            return tuple(self._stocks.codes())

        self._sync.update(
            run_id,
            phase="universe",
            message=f"正在获取股票列表与简称 (快照交易日 {latest_trading_day.isoformat()})",
        )
        snapshots = provider.fetch_stock_universe(latest_trading_day)
        _raise_if_cancelled(self._sync, run_id)

        stocks: list[StockInfo] = []
        for snapshot in snapshots:
            exchange, symbol = split_code(snapshot.code)
            stocks.append(
                StockInfo(
                    code=snapshot.code,
                    exchange=exchange,
                    symbol=symbol,
                    name=snapshot.name or None,
                    board=detect_board(snapshot.code),
                    is_active=snapshot.is_trading,
                )
            )
        entries = [
            (snapshot.code, latest_trading_day, snapshot.name)
            for snapshot in snapshots
            if snapshot.name
        ]
        with self._db.session() as conn:
            self._stocks.upsert_stocks(conn, stocks)
            self._stocks.upsert_name_history(conn, entries)
        logger.info("股票列表写入 %d 条 (快照 %s)", len(stocks), latest_trading_day)
        return tuple(self._stocks.codes())

    def _resolve_fetch_dates(
        self,
        mode: SyncMode,
        latest_trading_day: date,
        targets: tuple[date, ...],
        open_days: list[date],
    ) -> list[date]:
        """决定本次要下载哪些交易日。"""

        if mode is SyncMode.TARGETED:
            return sorted(set(targets))

        if mode is SyncMode.INCREMENTAL:
            synced = self._sync.synced_days()
            bar_start, _ = self._bars.bounds()
            cutoff = min(synced) if synced else (
                latest_trading_day - timedelta(days=_INCREMENTAL_LOOKBACK_DAYS)
            )
            if bar_start is not None:
                cutoff = min(cutoff, bar_start)
            return [day for day in open_days if day >= cutoff and day not in synced]

        return open_days

    # --- 抓取阶段 ---------------------------------------------------------

    def _save_ladder_pending(self, days: set[date]) -> None:
        with self._db.session() as conn:
            self._meta.set(conn, _LADDER_PENDING_KEY, _LADDER_DATES.dump_json(sorted(days)).decode("utf-8"))

    def _sync_ladder(self, provider: MarketDataProvider, run_id: str, plan: SyncPlan) -> tuple[str, str | None]:
        pending: set[date] = set()
        raw = self._meta.get(_LADDER_PENDING_KEY)
        if raw:
            try:
                pending.update(_LADDER_DATES.validate_json(raw))
            except ValidationError:
                logger.warning("忽略无效天梯待补日期记录")
        today = datetime.now(MARKET_TIMEZONE).date()
        start = today - timedelta(days=HISTORY_DAYS)
        recent_start = today - timedelta(days=45)
        ladder = LadderService(provider, self._db)
        expired = []
        for day in sorted(day for day in pending if day < start):
            saved = ladder.repository.get(day)
            if saved is None or not saved.is_final:
                expired.append(day)
        recent = {day for day in plan.fetch_dates if day >= recent_start}
        if plan.mode is not SyncMode.TARGETED:
            for day in self._calendar.open_days(recent_start, plan.latest_trading_day):
                saved = ladder.repository.get(day)
                if saved is None or not saved.is_final:
                    recent.add(day)
        pending = {day for day in pending | recent if start <= day <= plan.latest_trading_day}
        self._save_ladder_pending(pending)
        days = sorted(pending)
        failures: list[date] = []
        # 先保存近期涨停池, 避免全量日线下载耗时较长而错过上游可查窗口。
        for index, day in enumerate(days):
            _raise_if_cancelled(self._sync, run_id)
            self._sync.update(run_id, phase="ladder", message=f"正在补充连板天梯 {index + 1}/{len(days)}: {day}")
            try:
                saved = ladder.repository.get(day)
                snapshot = saved if saved and saved.is_final else ladder.download_snapshot(day)
                complete = bool(snapshot.items) and snapshot.is_final and not snapshot.stale
            except FindStockError as exc:
                complete = False
                logger.warning("天梯 %s 未补齐: %s", day, exc)
            if complete:
                pending.discard(day)
            else:
                failures.append(day)
            self._save_ladder_pending(pending)
        summary = f" 连板天梯 {len(days) - len(failures)}/{len(days)} 日已存档。" if days else ""
        warnings = []
        if failures:
            warnings.append("连板天梯未补齐: " + "、".join(map(str, failures)) + ", 下次数据更新自动重试。")
        if expired:
            warnings.append("以下天梯日期已超出在线补录范围: " + "、".join(map(str, expired)) + "。")
        warning = " ".join(warnings) or None
        return summary + (" " + warning if warning else ""), warning

    def _download(
        self, provider: MarketDataProvider, run_id: str, plan: SyncPlan, *, retry: bool = False
    ) -> dict[str, str]:
        fetcher = BulkFetcher(
            provider,
            workers=self._settings.sync_workers,
            chunk_size=self._settings.sync_chunk_size,
        )
        if retry:
            self._sync.update(run_id, phase="retry", message="正在补抓校验未通过的股票")
        else:
            self._sync.update(
                run_id, phase="bars", total_stocks=len(plan.codes),
                done_stocks=0, message="正在下载日线行情",
            )

        failures: dict[str, str] = {}
        total = len(plan.codes)
        remaining = list(plan.codes)
        open_days = set(self._calendar.open_days(plan.fetch_start, plan.fetch_end))
        stream = fetcher.fetch(remaining, plan.fetch_start, plan.fetch_end)
        try:
            for chunk in stream:
                _raise_if_cancelled(self._sync, run_id)
                if chunk.bars:
                    self._persist([bar for bar in chunk.bars if bar.trade_date in open_days])
                bad = {bar.code for bar in chunk.bars if _bar_problem(bar) or bar.pct_chg is None}
                dates_by_code: dict[str, set[date]] = {}
                for bar in chunk.bars:
                    dates_by_code.setdefault(bar.code, set()).add(bar.trade_date)
                succeeded = [
                    code for code in chunk.requested if code not in chunk.failed_codes
                    and code not in bad and set(plan.fetch_dates) <= dates_by_code.get(code, set())
                ]
                if succeeded:
                    self._mark_synced(succeeded, plan.fetch_end)
                for code in chunk.requested:
                    failures.pop(code, None)
                failures.update(dict(chunk.errors))
                for code in chunk.requested:
                    if code in remaining:
                        remaining.remove(code)
                done = total - len(remaining)
                if retry:
                    self._sync.update(run_id, message=f"已补抓 {done}/{total} 只股票")
                else:
                    self._sync.update(
                        run_id, done_stocks=done, message=f"已处理 {done}/{total} 只股票"
                    )
        finally:
            with contextlib.suppress(Exception):
                stream.close()

        if remaining:
            logger.warning("仍有 %d 只股票未能下载", len(remaining))
            failures.update({code: "抓取器未返回该股票的结果" for code in remaining})
        return failures

    def _persist(self, bars: Sequence[DailyBar]) -> None:
        with self._db.session() as conn:
            # 无效响应不能覆盖本地已有的有效行情，留给落库后校验与补抓处理。
            self._bars.upsert_bars(conn, (bar for bar in bars if not _bar_problem(bar)))

    def _mark_synced(self, codes: Sequence[str], fetch_end: date) -> None:
        with self._db.session() as conn:
            self._stocks.mark_codes_synced(conn, codes, fetch_end)

    def _verify(
        self, provider: MarketDataProvider, run_id: str, dates: tuple[date, ...]
    ) -> tuple[dict[date, int], dict[date, dict[str, str]], list[dict[str, object]]]:
        """从数据库回读逐日逐股核对，未知的缺行不视作停牌。"""
        stocks = self._stocks.list_all()
        if not stocks:
            raise RuntimeError("股票列表为空，无法校验数据完整性")
        first_bars = self._stocks.first_bar_dates()
        if not self._listing_checked and any(
            stock.ipo_date is None and (code not in first_bars or first_bars[code] >= dates[0])
            for code, stock in stocks.items()
        ):
            self._listing_checked = True
            try:
                listing_dates = provider.fetch_listing_dates()
                with self._db.session() as conn:
                    self._stocks.apply_ipo_dates(conn, listing_dates)
                stocks = self._stocks.list_all()
            except Exception as exc:  # noqa: BLE001 - 不能确认的上市前缺行仍按缺失报告
                logger.warning("上市日期核对失败: %s", exc)
        counts: dict[date, int] = {}
        problems: dict[date, dict[str, str]] = {}
        reports: list[dict[str, object]] = []
        for index, day in enumerate(dates):
            _raise_if_cancelled(self._sync, run_id)
            self._sync.update(
                run_id, phase="verifying",
                message=f"正在校验数据完整性 {index + 1}/{len(dates)}: {day}",
            )
            bars = {
                code: by_day[day] for code, by_day in self._bars.load_bars_for_dates([day]).items()
            }
            counts[day] = len(bars)
            required = {
                code for code, stock in stocks.items()
                if (stock.ipo_date is None or stock.ipo_date <= day)
                and (stock.out_date is None or day < stock.out_date)
            }
            missing = required - bars.keys()
            if missing and not self._delisting_checked:
                self._delisting_checked = True
                try:
                    delisted = provider.fetch_delisting_dates()
                    with self._db.session() as conn:
                        self._stocks.apply_delisting_dates(conn, delisted)
                    stocks = self._stocks.list_all()
                    required = {code for code in required
                                if stocks[code].out_date is None or day < stocks[code].out_date}
                    missing = required - bars.keys()
                except Exception as exc:  # noqa: BLE001 - 无证明仍按缺失报告
                    logger.warning("终止上市日期核对失败: %s", exc)
            if missing and bars and day not in self._suspensions:
                try:
                    self._suspensions[day] = provider.fetch_suspended_codes(day)
                except Exception as exc:  # noqa: BLE001 - 停牌证明取不到时不豁免缺行
                    logger.warning("%s 停牌核对失败: %s", day, exc)
                    self._suspensions[day] = set()
            suspended = missing & self._suspensions.get(day, set())
            missing -= suspended
            invalid: dict[str, str] = {}
            for code in required & bars.keys():
                bar = bars[code]
                problem = _bar_problem(bar)
                if not problem and bar.trade_status is not TradeStatus.SUSPENDED:
                    if bar.pct_chg is None and stocks[code].ipo_date != day:
                        problem = "缺少涨跌幅，且无法确认为上市首日"
                if problem:
                    invalid[code] = problem
            issues = {code: "缺少行情，未确认全天停牌" for code in sorted(missing)} | invalid
            if not bars:
                issues["整日"] = "整日无行情，上游可能尚未发布该日数据"
            if issues:
                problems[day] = issues
            reports.append({
                "date": day.isoformat(), "bar_count": len(bars),
                "expected_count": len(required) - len(suspended),
                "suspended_count": len(suspended), "missing_count": len(missing),
                "invalid_count": len(invalid), "passed": not issues,
                "samples": dict(list(issues.items())[:20]),
            })
        return counts, problems, reports

    def _finalize(
        self, provider: MarketDataProvider, run_id: str, plan: SyncPlan, failures: dict[str, str]
    ) -> str:
        """校验、补抓并再次回读，只给确认完整的日期记账。"""
        dates = set(plan.fetch_dates)
        if plan.mode is SyncMode.INCREMENTAL:
            synced = [day for day in self._sync.synced_days() if day <= plan.latest_trading_day]
            if synced:
                dates.add(max(synced))
        if not dates:
            return ""
        checked_dates = tuple(sorted(dates))
        counts, problems, reports = self._verify(provider, run_id, checked_dates)
        # 整日为空时不立即重抓全市场，报告未发布并留待下次增量重试。
        repair_dates = tuple(day for day in problems if counts[day] > 0)
        if repair_dates:
            codes = tuple(sorted({code for day in repair_dates for code in problems[day]}))
            repair = replace(plan, codes=codes, fetch_dates=repair_dates,
                             fetch_start=repair_dates[0], fetch_end=repair_dates[-1])
            retried_failures = self._download(provider, run_id, repair, retry=True)
            for code in codes:
                failures.pop(code, None)
            failures.update(retried_failures)
            counts, problems, reports = self._verify(provider, run_id, checked_dates)
        _raise_if_cancelled(self._sync, run_id)
        self._sync.update(run_id, phase="finalizing", message="正在保存完整性校验结果")
        problem_summary = "; ".join(
            f"{day}: {len(issues)} 项缺失或异常 ({', '.join(list(issues)[:5])})"
            for day, issues in problems.items()
        )
        with self._db.session() as conn:
            self._stocks.refresh_derived_listing_dates(conn)
            for day, count in counts.items():
                if day not in problems:
                    self._sync.mark_day_synced(conn, day, count)
                else:
                    conn.execute("DELETE FROM synced_day WHERE trade_date = ?", (day.isoformat(),))
            if not problems and plan.fetch_dates:
                self._stocks.mark_codes_synced(conn, plan.codes, plan.fetch_end)
            self._meta.set(conn, "last_sync_verification", json.dumps({
                "run_id": run_id, "checked_at": datetime.now(UTC).isoformat(timespec="seconds"),
                "passed": not problems, "days": reports,
            }, ensure_ascii=False))
            self._meta.set(conn, "last_sync_mode", plan.mode.value)
            self._meta.set(conn, "last_sync_provider", self._settings.provider)
            if not problems:
                self._meta.set(
                    conn, "last_sync_finished_at", datetime.now(UTC).isoformat(timespec="seconds")
                )
            self._meta.set(
                conn,
                "last_sync_failures",
                problem_summary or (
                    f"{len(failures)} 只股票未取到数据: " + ", ".join(list(failures)[:20])
                    if failures else ""
                ),
            )
        self._sync.update(
            run_id, done_days=sum(day not in problems for day in plan.fetch_dates)
        )
        if problems:
            logger.error("完整性校验未通过: %s", problem_summary)
            raise RuntimeError(f"数据完整性校验未通过: {problem_summary}。未完成日期将在下次增量更新重试。")
        return f" 完整性校验通过: {len(checked_dates)} 个交易日，逐日核对行情、字段及停牌/上市例外。"

    def _success_message(self, plan: SyncPlan) -> str:
        return (
            f"{plan.mode.label}完成, 覆盖 {plan.fetch_start.isoformat()} ~ "
            f"{plan.fetch_end.isoformat()} 共 {len(plan.fetch_dates)} 个交易日。"
        )


def _raise_if_cancelled(sync: SyncRepository, run_id: str) -> None:
    progress = sync.get(run_id)
    if progress is not None and progress.status is not SyncStatus.RUNNING:
        raise SyncCancelledError()


def latest_usable_day(now: datetime) -> date:
    """返回 "行情已经走完" 的最后一个自然日。

    收盘前当天的行情不完整, 必须回退一天, 否则盘中更新会把半天数据
    当成完整交易日记账。
    """

    if now.tzinfo is not None:
        now = now.astimezone(MARKET_TIMEZONE)
    if now.time() >= _MARKET_CLOSE:
        return now.date()
    return now.date() - timedelta(days=1)


def _bar_problem(bar: DailyBar) -> str | None:
    if bar.trade_status is TradeStatus.SUSPENDED:
        return None
    prices = [bar.open, bar.high, bar.low, bar.close]
    if any(value is None or not math.isfinite(float(value)) or value <= 0 for value in prices):
        return "价格缺失、非有限值或非正数"
    if bar.high < max(bar.open, bar.close, bar.low) or bar.low > min(bar.open, bar.close):
        return "最高/最低价与开收盘价矛盾"
    if bar.volume is None or not math.isfinite(float(bar.volume)) or bar.volume < 0:
        return "成交量缺失或为负"
    if bar.amount is not None and (not math.isfinite(float(bar.amount)) or bar.amount < 0):
        return "成交额不是有效非负数"
    if bar.turnover is not None and (
        not math.isfinite(float(bar.turnover)) or float(bar.turnover) < 0
    ):
        return "换手率不是有效非负数"
    if bar.preclose is not None and (not math.isfinite(float(bar.preclose)) or bar.preclose <= 0):
        return "前收盘价不是有效正数"
    if bar.pct_chg is not None and not math.isfinite(float(bar.pct_chg)):
        return "涨跌幅不是有限值"
    if bar.pct_chg is None and bar.preclose is not None:
        return "缺少涨跌幅"
    return None
