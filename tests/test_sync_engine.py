"""同步引擎计划逻辑测试 (不访问网络)。"""

from __future__ import annotations

import json
from dataclasses import replace
from datetime import UTC, date, datetime
from decimal import Decimal

import pytest

from app.core.errors import ProviderError
from app.domain.enums import SyncMode, SyncStatus
from app.domain.ladder import LimitUpStock
from app.providers.base import StockSnapshot
from app.repositories.ladder_repository import LadderRepository
from app.services import ladder_service, sync_engine
from app.services.ladder_service import MARKET_TIMEZONE
from app.services.sync_engine import SyncEngine, latest_usable_day
from tests.factories import make_bar, make_stock, seed

def test_before_close_today_is_not_usable() -> None:
    """盘中执行更新时, 当天行情不完整, 不能算作可用日期。"""

    assert latest_usable_day(datetime(2026, 9, 21, 0, 1)) == date(2026, 9, 20)
    assert latest_usable_day(datetime(2026, 9, 21, 14, 59)) == date(2026, 9, 20)
    assert latest_usable_day(datetime(2026, 9, 21, 15, 29)) == date(2026, 9, 20)


def test_after_close_today_is_usable() -> None:
    assert latest_usable_day(datetime(2026, 9, 21, 15, 30)) == date(2026, 9, 21)
    assert latest_usable_day(datetime(2026, 9, 21, 20, 0)) == date(2026, 9, 21)
    assert latest_usable_day(datetime(2026, 9, 21, 7, 29, tzinfo=UTC)) == date(2026, 9, 20)
    assert latest_usable_day(datetime(2026, 9, 21, 7, 30, tzinfo=UTC)) == date(2026, 9, 21)


OLD, FIRST, LATEST = date(2026, 10, 13), date(2026, 10, 14), date(2026, 10, 15)
CODE = "sh.600001"


class SyncProvider:
    def __init__(self):
        self.calls = []
        self.failed_days = set()
        self.empty_days = set()
        self.on_pool = lambda day: None
        self.closed = False

    def open(self):
        self.closed = False

    def close(self):
        self.closed = True

    def fetch_trading_calendar(self, start, end):
        return [(day, True) for day in (OLD, FIRST, LATEST) if start <= day <= end]

    def fetch_stock_universe(self, day):
        return [StockSnapshot(CODE, "测试股份", True)]

    def fetch_daily_bars(self, code, start, end):
        self.calls.append(("bars", start, end))
        return [make_bar(code, day) for day in (OLD, FIRST, LATEST) if start <= day <= end]

    def fetch_listing_dates(self):
        return {CODE: date(2000, 1, 1)}

    def fetch_suspended_codes(self, day):
        return set()

    def fetch_delisting_dates(self):
        return {}

    def fetch_limit_up_pool(self, day):
        self.calls.append(("ladder", day))
        self.on_pool(day)
        if day in self.failed_days:
            raise ProviderError("上游暂不可用")
        if day in self.empty_days:
            return []
        return [LimitUpStock(
            code=CODE, name="测试股份", consecutive=2, price=11.0, pct_chg=10.0,
            amount=1e8, turnover=2.0, seal_funds=1e7, first_seal="09:30:00",
            last_seal="14:00:00", breaks=1, industry="软件开发", board="main_sh",
            board_label="沪市主板", is_st=False,
        )]

    def fetch_limit_up_pool_ths(self, day):
        return []


@pytest.fixture()
def engine(container, monkeypatch):
    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            instant = datetime(2026, 10, 15, 16, tzinfo=MARKET_TIMEZONE)
            return instant.astimezone(tz) if tz else instant.replace(tzinfo=None)
    monkeypatch.setattr(sync_engine, "datetime", Clock)
    monkeypatch.setattr(ladder_service, "datetime", Clock)
    seed(container, open_days=[OLD, FIRST, LATEST], stocks=[make_stock(CODE)],
         bars=[make_bar(CODE, OLD)], names={LATEST: [(CODE, "测试股份")]})
    provider = SyncProvider()
    instance = SyncEngine(
        container.settings, container.database,
        calendar_repository=container.calendar_repository,
        stock_repository=container.stock_repository,
        bar_repository=container.bar_repository,
        sync_repository=container.sync_repository,
        meta_repository=container.meta_repository,
        provider_factory=lambda: provider,
    )
    return instance, provider


def run_sync(container, engine, run_id="sync-ladder", mode=SyncMode.INCREMENTAL, dates=None):
    container.sync_repository.create_run(run_id, mode)
    engine.run(mode, run_id, target_dates=dates)
    return container.sync_repository.get(run_id)


def pending_dates(container):
    return json.loads(container.meta_repository.get("ladder_sync_pending_dates:v1"))


def test_incremental_archives_new_dates_before_downloading_bars(container, engine):
    instance, provider = engine
    result = run_sync(container, instance)
    assert provider.calls == [("ladder", OLD), ("ladder", FIRST), ("ladder", LATEST), ("bars", FIRST, LATEST)]
    assert LadderRepository(container.database).dates() == [OLD, FIRST, LATEST]
    assert container.sync_repository.synced_days() == {OLD, FIRST, LATEST}
    assert result.status is SyncStatus.SUCCEEDED and result.error is None
    assert "连板天梯 3/3 日已存档" in result.message
    assert pending_dates(container) == [] and provider.closed


@pytest.mark.parametrize("mode, dates, expected", [
    (SyncMode.FULL, None, [OLD, FIRST, LATEST]),
    (SyncMode.TARGETED, [FIRST], [FIRST]),
])
def test_full_and_targeted_download_also_archive_ladder(container, engine, mode, dates, expected):
    instance, provider = engine
    run_sync(container, instance, mode=mode, dates=dates)
    assert [call[1] for call in provider.calls if call[0] == "ladder"] == expected
    assert LadderRepository(container.database).dates() == expected


@pytest.mark.parametrize("failure_kind", ["failed_days", "empty_days"])
def test_ladder_failure_keeps_bars_and_retries_even_when_bars_are_current(container, engine, failure_kind):
    instance, provider = engine
    getattr(provider, failure_kind).add(FIRST)
    first = run_sync(container, instance)
    assert first.status is SyncStatus.SUCCEEDED and str(FIRST) in first.error
    assert "2/3 日已存档" in first.message
    assert container.sync_repository.synced_days() == {OLD, FIRST, LATEST}
    assert pending_dates(container) == [FIRST.isoformat()]
    getattr(provider, failure_kind).clear()
    provider.calls.clear()
    retried = run_sync(container, instance, run_id="retry-ladder")
    assert provider.calls == [("ladder", FIRST)]
    assert retried.error is None and "本地日线已是最新" in retried.message
    assert "1/1 日已存档" in retried.message and pending_dates(container) == []
    provider.calls.clear()
    run_sync(container, instance, run_id="already-current")
    assert provider.calls == []


def test_cancel_keeps_completed_snapshots_and_resumes_pending_dates(container, engine):
    instance, provider = engine
    provider.on_pool = lambda day: container.sync_repository.request_cancel("cancel-ladder")
    result = run_sync(container, instance, run_id="cancel-ladder")
    assert result.status is SyncStatus.CANCELLED and provider.closed
    assert LadderRepository(container.database).dates() == [OLD]
    assert pending_dates(container) == [FIRST.isoformat(), LATEST.isoformat()]
    assert provider.calls == [("ladder", OLD)]
    provider.on_pool = lambda day: None
    provider.calls.clear()
    resumed = run_sync(container, instance, run_id="resume-ladder")
    assert provider.calls == [("ladder", FIRST), ("ladder", LATEST), ("bars", FIRST, LATEST)]
    assert resumed.error is None and pending_dates(container) == []


def test_existing_final_archive_is_reused_and_expired_retry_is_reported(container, engine):
    instance, provider = engine
    run_sync(container, instance)
    provider.calls.clear()
    targeted = run_sync(container, instance, run_id="reuse-ladder", mode=SyncMode.TARGETED, dates=[FIRST])
    assert provider.calls == [("bars", FIRST, FIRST)]
    assert targeted.error is None and "1/1 日已存档" in targeted.message
    with container.database.session() as conn:
        container.meta_repository.set(conn, "ladder_sync_pending_dates:v1", '["2025-08-01"]')
    provider.calls.clear()
    result = run_sync(container, instance, run_id="expired-ladder")
    assert "超出在线补录范围" in result.error and "2025-08-01" in result.message
    assert provider.calls == [] and pending_dates(container) == []


def verification(container):
    return json.loads(container.meta_repository.get("last_sync_verification"))


def test_unpublished_whole_day_does_not_report_success(container, engine, monkeypatch):
    instance, provider = engine
    monkeypatch.setattr(provider, "fetch_daily_bars", lambda code, start, end: [make_bar(code, FIRST)])
    with pytest.raises(RuntimeError, match="完整性校验未通过"):
        run_sync(container, instance)
    result = container.sync_repository.get("sync-ladder")
    assert result.status is SyncStatus.FAILED
    assert (result.done_days, result.total_days) == (1, 2)
    assert container.sync_repository.synced_days() == {OLD, FIRST}
    assert container.stock_repository.codes_needing_sync(LATEST) == [CODE]
    report = verification(container)
    assert not report["passed"]
    assert report["days"][-1]["bar_count"] == 0
    assert "整日无行情" in report["days"][-1]["samples"]["整日"]


def test_incremental_fills_hole_before_latest_completed_day(container, engine):
    instance, provider = engine
    seed(container, open_days=[LATEST], bars=[make_bar(CODE, LATEST)])
    run_sync(container, instance)
    assert ("bars", FIRST, FIRST) in provider.calls
    assert container.sync_repository.synced_days() == {OLD, FIRST, LATEST}


def test_incremental_includes_partial_history_before_first_complete_day(container, engine):
    instance, provider = engine
    with container.database.session() as conn:
        conn.execute("DELETE FROM synced_day")
    seed(container, open_days=[LATEST], bars=[make_bar(CODE, LATEST)])
    run_sync(container, instance)
    assert ("bars", OLD, FIRST) in provider.calls
    assert container.sync_repository.synced_days() == {OLD, FIRST, LATEST}


OTHER = "sz.000002"


@pytest.mark.parametrize("recovered", [True, False])
def test_missing_stock_is_retried_and_rechecked(container, engine, monkeypatch, recovered):
    instance, provider = engine
    seed(container, open_days=[OLD], stocks=[make_stock(OTHER)], bars=[make_bar(OTHER, OLD)])
    attempts = {}

    def fetch(code, start, end):
        attempts[code] = attempts.get(code, 0) + 1
        return [make_bar(code, day) for day in (FIRST, LATEST) if start <= day <= end
                and not (code == OTHER and day == LATEST and (not recovered or attempts[code] == 1))]

    monkeypatch.setattr(provider, "fetch_daily_bars", fetch)
    if recovered:
        result = run_sync(container, instance)
        assert result.status is SyncStatus.SUCCEEDED
        assert "完整性校验通过" in result.message
        assert verification(container)["passed"]
        assert container.bar_repository.count_on(LATEST) == 2
        assert (result.done_stocks, result.total_stocks) == (2, 2)
    else:
        with pytest.raises(RuntimeError, match=OTHER):
            run_sync(container, instance)
        assert LATEST not in container.sync_repository.synced_days()
        assert verification(container)["days"][-1]["missing_count"] == 1
    assert attempts == {CODE: 1, OTHER: 2}


def test_confirmed_suspension_is_exempt_without_fabricating_bars(container, engine, monkeypatch):
    instance, provider = engine
    seed(container, open_days=[OLD], stocks=[make_stock(OTHER)], bars=[make_bar(OTHER, OLD)])
    monkeypatch.setattr(provider, "fetch_daily_bars", lambda code, start, end:
                        [make_bar(code, day) for day in (FIRST, LATEST)] if code == CODE else [])
    monkeypatch.setattr(provider, "fetch_suspended_codes", lambda day: {OTHER})
    result = run_sync(container, instance)
    assert result.status is SyncStatus.SUCCEEDED
    assert container.bar_repository.count_on(LATEST) == 1
    assert verification(container)["days"][-1]["suspended_count"] == 1


def test_listing_before_ipo_is_exempt_and_ipo_pct_can_be_empty(container, engine, monkeypatch):
    instance, provider = engine
    seed(container, open_days=[OLD], stocks=[make_stock(OTHER)])
    monkeypatch.setattr(provider, "fetch_listing_dates", lambda: {OTHER: LATEST, CODE: date(2000, 1, 1)})
    monkeypatch.setattr(provider, "fetch_daily_bars", lambda code, start, end:
                        [make_bar(code, day) for day in (FIRST, LATEST)] if code == CODE else
                        [replace(make_bar(code, LATEST), preclose=None, pct_chg=None)])
    result = run_sync(container, instance)
    assert result.status is SyncStatus.SUCCEEDED
    assert container.bar_repository.count_on(FIRST) == 1
    assert container.stock_repository.list_all()[OTHER].ipo_date == LATEST


def test_current_marker_is_rechecked_and_removed_if_invalid(container, engine, monkeypatch):
    instance, provider = engine
    bad = replace(make_bar(CODE, LATEST), high=Decimal("1"))
    seed(container, open_days=[FIRST, LATEST], bars=[make_bar(CODE, FIRST), bad])
    monkeypatch.setattr(provider, "fetch_daily_bars", lambda *args: [bad])
    with pytest.raises(RuntimeError, match="完整性校验未通过"):
        run_sync(container, instance)
    assert LATEST not in container.sync_repository.synced_days()
    assert verification(container)["days"][-1]["invalid_count"] == 1
    assert instance._resolve_fetch_dates(SyncMode.INCREMENTAL, LATEST, (), [OLD, FIRST, LATEST]) == [LATEST]


@pytest.mark.parametrize("field, value", [
    ("close", None), ("close", Decimal("NaN")), ("close", Decimal("Infinity")),
    ("close", Decimal("-1")), ("volume", -1), ("amount", Decimal("NaN")),
    ("turnover", "inf"), ("turnover", "-1"), ("pct_chg", Decimal("NaN")),
])
def test_bad_response_cannot_replace_existing_valid_bar(container, engine, field, value):
    instance, _ = engine
    original = container.bar_repository.load_recent_bars(CODE)[0]
    instance._persist([replace(make_bar(CODE, OLD), **{field: value})])
    assert container.bar_repository.load_recent_bars(CODE)[0] == original


def test_cancel_during_verification_is_not_overwritten_as_success(container, engine, monkeypatch):
    instance, _ = engine
    update = container.sync_repository.update

    def cancel_on_verification(run_id, **fields):
        update(run_id, **fields)
        if fields.get("phase") == "verifying":
            container.sync_repository.request_cancel(run_id)

    monkeypatch.setattr(container.sync_repository, "update", cancel_on_verification)
    result = run_sync(container, instance)
    assert result.status is SyncStatus.CANCELLED
    assert container.sync_repository.synced_days() == {OLD}


@pytest.mark.parametrize("day", [date(2026, 10, 17), date(2026, 10, 16)])
def test_targeted_cannot_mark_future_or_nontrading_day_complete(container, engine, day):
    instance, provider = engine
    with pytest.raises(ValueError, match="已经收盘的交易日"):
        run_sync(container, instance, mode=SyncMode.TARGETED, dates=[day])
    assert provider.calls == [] and provider.closed


def test_confirmed_delisting_removes_future_obligation_but_keeps_history(container, engine, monkeypatch):
    instance, provider = engine
    seed(container, open_days=[OLD], stocks=[make_stock(OTHER)], bars=[make_bar(OTHER, OLD)])
    monkeypatch.setattr(provider, "fetch_delisting_dates", lambda: {OTHER: FIRST})
    monkeypatch.setattr(provider, "fetch_daily_bars", lambda code, start, end:
                        [make_bar(code, day) for day in (FIRST, LATEST)] if code == CODE else [])
    assert run_sync(container, instance).status is SyncStatus.SUCCEEDED
    stock = container.stock_repository.get(OTHER)
    assert stock.out_date == FIRST and not stock.is_active
    with container.database.session() as conn:
        container.stock_repository.upsert_stocks(conn, [make_stock(OTHER)])
    assert not container.stock_repository.get(OTHER).is_active
    assert container.bar_repository.load_recent_bars(OTHER)[0].trade_date == OLD
    assert OTHER not in instance._build_plan(provider, SyncMode.TARGETED, "sync-ladder", [LATEST]).codes


def test_delisting_lookup_failure_cannot_exempt_a_missing_stock(container, engine, monkeypatch):
    instance, provider = engine
    seed(container, open_days=[OLD], stocks=[make_stock(OTHER)], bars=[make_bar(OTHER, OLD)])
    monkeypatch.setattr(provider, "fetch_daily_bars", lambda code, start, end:
                        [make_bar(code, day) for day in (FIRST, LATEST)] if code == CODE else [])
    def fail():
        raise ProviderError("交易所不可达")
    monkeypatch.setattr(provider, "fetch_delisting_dates", fail)
    with pytest.raises(RuntimeError, match=OTHER):
        run_sync(container, instance)
    assert LATEST not in container.sync_repository.synced_days()


def test_partial_response_cannot_erase_existing_pct_or_optional_fields(container, engine):
    instance, _ = engine
    original = replace(make_bar(CODE, OLD), amount=Decimal("12345"), turnover=Decimal("2"))
    instance._persist([original])
    instance._persist([replace(original, preclose=None, pct_chg=None, close=Decimal("9"))])
    assert container.bar_repository.load_recent_bars(CODE)[0] == original
    instance._persist([replace(original, amount=None, turnover=None)])
    assert container.bar_repository.load_recent_bars(CODE)[0] == original


def test_repeating_incremental_sync_is_idempotent(container, engine):
    instance, provider = engine
    run_sync(container, instance)
    before = container.bar_repository.load_recent_bars(CODE)
    snapshots = [LadderRepository(container.database).get(day) for day in (OLD, FIRST, LATEST)]
    provider.calls.clear()
    assert run_sync(container, instance, run_id="repeat").status is SyncStatus.SUCCEEDED
    assert provider.calls == []
    assert container.bar_repository.load_recent_bars(CODE) == before
    assert [LadderRepository(container.database).get(day) for day in (OLD, FIRST, LATEST)] == snapshots
