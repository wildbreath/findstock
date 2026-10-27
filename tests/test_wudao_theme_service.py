"""悟道批量下载、预算、续传与本地持久化；全部使用离线数据源。"""

import json
import os
from datetime import date, datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from app.core.errors import InvalidRequestError, ProviderError, SyncAlreadyRunningError
from app.main import create_app
from app.providers.wudao_provider import WudaoPage
from app.repositories.wudao_repository import WudaoRepository
from app.services import wudao_theme_service as module
from app.services.ladder_service import MARKET_TIMEZONE
from app.services.wudao_theme_service import WudaoThemeService

FIRST, LAST = date(2026, 10, 19), date(2026, 10, 23)
KEY = "lb_local_test_secret"


def row(day=LAST, code="600000", theme="机器人概念"):
    return {"date": day.isoformat(), "code": code, "name": "测试股份",
            "primaryTheme": theme, "reasonInfo": "完整涨停原因", "extra": {"retained": True}}


def page(rows, *, number=1, total=None):
    total = len(rows) if total is None else total
    pages = (total + 99) // 100
    raw = {"success": True, "data": {"rows": rows, "pagination": {
        "page": number, "pageSize": 100, "total": total, "totalPages": pages,
    }}, "meta": {"qualityWarnings": []}}
    return WudaoPage(rows, number, 100, total, pages, raw)


def seed_days(container, days):
    with container.database.session() as conn:
        conn.executemany(
            "INSERT INTO ladder_snapshot (trade_date,fetched_at,payload) VALUES (?,?,?)",
            [(day.isoformat(), "2026-10-24T08:00:00+00:00", "{}") for day in days],
        )


def stored(container, table):
    assert table in {"wudao_theme_batch", "wudao_theme_page", "wudao_theme_row"}
    with container.database.session() as conn:
        return [dict(value) for value in conn.execute(f"SELECT * FROM {table}")]


@pytest.fixture()
def sync(container, monkeypatch):
    monkeypatch.delenv("WUDAO_API_KEY", raising=False)
    monkeypatch.setattr(module, "_now", lambda: datetime(2026, 10, 24, 18, tzinfo=MARKET_TIMEZONE))
    monkeypatch.setattr(module.time, "sleep", lambda seconds: None)
    seed_days(container, [FIRST, LAST])
    with container.database.session() as conn:
        container.calendar_repository.upsert_days(conn, [
            (date(2026, 10, 24), False), (date(2026, 10, 25), False),
            (date(2026, 10, 26), True), (date(2026, 10, 27), True),
        ])
    fake = {"calls": [], "closed": 0, "keys": [],
            "reply": lambda start, end, number: page([row(FIRST), row(LAST)])}

    class Provider:
        def __init__(self, key, timeout):
            fake["keys"].append(key)

        def fetch_page(self, start, end, number):
            if fake.get("initialize") is not None:
                fake["initialize"]()
            if getattr(self, "before_query", None) is not None:
                self.before_query()
            fake["calls"].append((start, end, number))
            return fake["reply"](start, end, number)

        def close(self):
            fake["closed"] += 1

    monkeypatch.setattr(module, "WudaoProvider", Provider)
    service = WudaoThemeService(container.settings, container.database)
    service.configure(KEY)
    return service, fake


def test_newest_sixty_days_first_then_older_history(container, sync):
    service, fake = sync
    with container.database.session() as conn:
        conn.execute("DELETE FROM ladder_snapshot")
    days = [date(2026, 5, 1) + timedelta(days=offset) for offset in range(65)]
    seed_days(container, days)
    fake["reply"] = lambda start, end, number: page([row(day) for day in days if start <= day <= end])
    result = service.synchronize()
    assert fake["calls"] == [(days[-60], days[-1], 1), (days[0], days[-61], 1)]
    assert result["completed_days"] == 65 and result["pending_days"] == 0
    assert all(batch["status"] == "complete" for batch in stored(container, "wudao_theme_batch"))


def test_one_short_history_batch_is_saved_with_all_raw_fields(container, sync):
    service, fake = sync
    result = service.synchronize()
    assert fake["calls"] == [(FIRST, LAST, 1)]
    assert result["completed_days"] == 2 and result["calls_today"] == 1
    saved = stored(container, "wudao_theme_row")[0]
    assert saved["code"] == "sh.600000" and saved["primary_theme"] == "机器人概念"
    assert json.loads(saved["payload"])["extra"] == {"retained": True}
    raw = json.loads(stored(container, "wudao_theme_page")[0]["payload"])
    assert raw["data"]["rows"][0]["reasonInfo"] == "完整涨停原因"
    assert raw["meta"] == {"qualityWarnings": []}
    assert fake["closed"] == 1
    assert KEY not in json.dumps(result)


def test_completed_history_is_not_downloaded_again(container, sync):
    service, fake = sync
    service.synchronize()
    before = {table: stored(container, table) for table in (
        "wudao_theme_batch", "wudao_theme_page", "wudao_theme_row",
    )}
    fake["calls"].clear()
    result = service.synchronize()
    assert fake["calls"] == [] and result["calls_today"] == 1
    assert all(stored(container, table) == values for table, values in before.items())


def test_page_limit_saves_cursor_and_next_run_resumes(container, sync):
    service, fake = sync
    rows = [row(FIRST if index == 0 else LAST, code=f"{600000 + index:06}") for index in range(101)]
    fake["reply"] = lambda start, end, number: page(
        rows[(number - 1) * 100:number * 100], number=number, total=101,
    )
    first = service.synchronize(max_calls=1)
    assert first["completed_days"] == 0 and first["pending_days"] == 2
    batch = stored(container, "wudao_theme_batch")[0]
    assert batch["next_page"] == 2 and batch["status"] == "pending"
    assert len(stored(container, "wudao_theme_row")) == 100
    assert not WudaoRepository(container.database).day(LAST)[2]
    second = service.synchronize(max_calls=1)
    assert fake["calls"] == [(FIRST, LAST, 1), (FIRST, LAST, 2)]
    assert second["completed_days"] == 2 and second["calls_today"] == 2
    assert len(stored(container, "wudao_theme_row")) == 101
    assert WudaoRepository(container.database).day(LAST)[2]


def test_fifty_call_daily_ceiling_resumes_next_day(container, sync, monkeypatch):
    service, fake = sync

    def reply(start, end, number):
        first = (number - 1) * 100
        rows = [row(FIRST if index == 0 else LAST, code=f"{600000 + index:06}")
                for index in range(first, min(first + 100, 5001))]
        return page(rows, number=number, total=5001)

    fake["reply"] = reply
    first = service.synchronize()
    assert len(fake["calls"]) == 50 and first["calls_today"] == 50
    assert first["pending_days"] == 2
    blocked = service.synchronize()
    assert len(fake["calls"]) == 50 and "50次" in blocked["error"]
    assert stored(container, "wudao_theme_batch")[0]["next_page"] == 51
    monkeypatch.setattr(module, "_now", lambda: datetime(2026, 10, 25, 18, tzinfo=MARKET_TIMEZONE))
    second = service.synchronize()
    assert fake["calls"][-1] == (FIRST, LAST, 51)
    assert second["calls_today"] == 1 and second["pending_days"] == 0
    assert len(stored(container, "wudao_theme_row")) == 5001


def test_failed_request_spends_one_budget_and_is_not_automatically_retried(container, sync):
    service, fake = sync

    def fail(start, end, number):
        raise ProviderError("悟道网络请求失败；未自动重试")

    fake["reply"] = fail
    result = service.synchronize()
    assert result["calls_today"] == 1 and result["pending_days"] == 2
    assert len(fake["calls"]) == 1 and fake["closed"] == 1
    assert stored(container, "wudao_theme_page") == []
    assert stored(container, "wudao_theme_batch")[0]["next_page"] == 1
    fake["reply"] = lambda start, end, number: page([row(FIRST), row(LAST)])
    retry = service.synchronize()
    assert retry["pending_days"] == 0 and retry["calls_today"] == 2
    assert fake["calls"][-1] == (FIRST, LAST, 1)


@pytest.mark.parametrize("change", ["duplicate", "total"])
def test_bad_second_page_rolls_back_every_row_and_cursor(container, sync, change):
    service, fake = sync
    rows = [row(FIRST if index == 0 else LAST, code=f"{600000 + index:06}") for index in range(100)]

    def reply(start, end, number):
        if number == 1:
            return page(rows, total=102)
        if change == "duplicate":
            return page([row(code="600999"), rows[0]], number=2, total=102)
        return page([row(code="600998"), row(code="600999"), row(code="601000")], number=2, total=103)

    fake["reply"] = reply
    result = service.synchronize(max_calls=2)
    assert result["error"] and result["completed_days"] == 0
    assert len(stored(container, "wudao_theme_row")) == 100
    assert len(stored(container, "wudao_theme_page")) == 1
    batch = stored(container, "wudao_theme_batch")[0]
    assert batch["next_page"] == 2 and batch["total"] == 102 and batch["status"] == "superseded"
    assert WudaoRepository(container.database).day(LAST)[0] == {}
    fake["reply"] = lambda start, end, number: page([row(FIRST, theme="芯片"), row(LAST, theme="芯片")])
    resumed = service.synchronize()
    assert fake["calls"][-1] == (FIRST, LAST, 1)
    assert resumed["pending_days"] == 0
    assert WudaoRepository(container.database).day(LAST)[0] == {"sh.600000": "芯片"}


def test_empty_response_never_claims_local_history_complete(container, sync):
    service, fake = sync
    fake["reply"] = lambda start, end, number: page([])
    result = service.synchronize()
    assert "空结果" in result["error"] and result["completed_days"] == 0
    assert stored(container, "wudao_theme_row") == []
    assert stored(container, "wudao_theme_page") == []


def test_same_stock_different_day_has_separate_primary_theme(container, sync):
    service, fake = sync
    fake["reply"] = lambda start, end, number: page([
        row(FIRST, theme="机器人概念"), row(LAST, theme="并购重组"),
        row(LAST, code="000001", theme=None), row(LAST, code="920075", theme="芯片"),
    ])
    service.synchronize()
    repository = WudaoRepository(container.database)
    assert repository.day(FIRST)[0] == {"sh.600000": "机器人概念"}
    assert repository.day(LAST)[0] == {
        "sh.600000": "并购重组", "sz.000001": None, "bj.920075": "芯片",
    }


def test_no_key_prevents_claim_or_network(container, monkeypatch):
    monkeypatch.delenv("WUDAO_API_KEY", raising=False)
    monkeypatch.setattr(module, "_now", lambda: datetime(2026, 10, 24, 18, tzinfo=MARKET_TIMEZONE))
    service = WudaoThemeService(container.settings, container.database)
    monkeypatch.setattr(module, "WudaoProvider", lambda *a, **kw: pytest.fail("no network"))
    assert not service.status()["configured"]
    with pytest.raises(InvalidRequestError, match="密钥"):
        service.synchronize()
    assert service._state() == {}


def test_configuration_and_status_never_return_key(container, sync, monkeypatch):
    service, _ = sync
    assert service.status()["configured"]
    assert (container.settings.data_dir / "wudao_api_key").read_text(encoding="utf-8") == KEY
    monkeypatch.setenv("WUDAO_API_KEY", "lb_environment_secret")
    result = service.configure("lb_another_local_secret")
    assert service._key() == "lb_environment_secret"
    encoded = json.dumps(result)
    assert not any(key in encoded for key in (KEY, "lb_environment_secret", "lb_another_local_secret"))


def test_running_download_blocks_second_owner_and_key_replacement(container, sync):
    service, fake = sync
    service._claim()
    with pytest.raises(SyncAlreadyRunningError):
        WudaoThemeService(container.settings, container.database).synchronize()
    with pytest.raises(SyncAlreadyRunningError):
        service.configure("lb_replacement")
    assert service.status()["running"] and fake["calls"] == []


def test_stale_process_claim_can_be_recovered(container, sync, monkeypatch):
    service, fake = sync
    service._write_state(running=True, pid=-1)
    monkeypatch.setattr(module, "_pid_alive", lambda pid: pid == os.getpid())
    assert service.synchronize()["pending_days"] == 0
    assert len(fake["calls"]) == 1


def test_restricted_free_window_does_not_spend_or_request(container, sync, monkeypatch):
    service, fake = sync
    monkeypatch.setattr(module, "_now", lambda: datetime(2026, 10, 24, 9, 30, tzinfo=MARKET_TIMEZONE))
    before = service._state()
    with pytest.raises(InvalidRequestError, match="09:15"):
        service.synchronize()
    assert service._state() == before and service.status()["calls_today"] == 0
    assert fake["calls"] == []


@pytest.mark.parametrize("hour,minute", [(0, 0), (9, 15), (11, 45), (12, 30), (14, 59), (15, 0), (15, 29)])
@pytest.mark.parametrize("method", ["start", "synchronize"])
def test_trading_day_before_1530_never_claims_or_spends(container, sync, monkeypatch, hour, minute, method):
    service, fake = sync
    monkeypatch.setattr(module, "_now", lambda: datetime(2026, 10, 26, hour, minute, tzinfo=MARKET_TIMEZONE))
    before = service._state()
    with pytest.raises(InvalidRequestError, match="15:30"):
        getattr(service, method)()
    assert service._state() == before
    status = service.status()
    assert not status["running"] and not status["download_allowed"]
    assert "15:30" in status["download_block_reason"]
    assert status["calls_today"] == 0 and fake["calls"] == [] and fake["keys"] == []


def test_at_1530_only_closed_dates_download_and_all_new_batches_are_final(container, sync, monkeypatch):
    service, fake = sync
    current, future = date(2026, 10, 26), date(2026, 10, 27)
    seed_days(container, [current, future])
    monkeypatch.setattr(module, "_now", lambda: datetime(2026, 10, 26, 15, 29, tzinfo=MARKET_TIMEZONE))
    assert service._days() == [FIRST, LAST]
    monkeypatch.setattr(module, "_now", lambda: datetime(2026, 10, 26, 15, 30, tzinfo=MARKET_TIMEZONE))
    fake["reply"] = lambda start, end, number: page([
        row(day) for day in (FIRST, LAST, current) if start <= day <= end
    ])
    result = service.synchronize()
    assert result["completed_days"] == result["total_days"] == 3 and result["download_allowed"]
    assert set(fake["calls"]) == {(FIRST, LAST, 1), (current, current, 1)}
    assert all(batch["is_final"] == 1 for batch in stored(container, "wudao_theme_batch"))
    assert all(end < future for start, end, number in fake["calls"])
    fake["calls"].clear()
    service.synchronize()
    assert fake["calls"] == []


@pytest.mark.parametrize("known_closed", [date(2026, 10, 24), date(2026, 10, 25), date(2026, 10, 27)])
def test_explicit_nontrading_day_can_download_history_before_1530(container, sync, monkeypatch, known_closed):
    service, fake = sync
    with container.database.session() as conn:
        container.calendar_repository.upsert_days(conn, [(known_closed, False)])
    monkeypatch.setattr(module, "_now", lambda: datetime.combine(known_closed, datetime.min.time(), MARKET_TIMEZONE).replace(hour=12))
    status = service.synchronize()
    assert status["download_allowed"] and status["completed_days"] == 2
    assert fake["calls"] == [(FIRST, LAST, 1)]


@pytest.mark.parametrize("unknown", [date(2026, 10, 28), date(2026, 10, 31)])
def test_unknown_local_calendar_conservatively_blocks_even_weekend(container, sync, monkeypatch, unknown):
    service, fake = sync
    monkeypatch.setattr(module, "_now", lambda: datetime.combine(unknown, datetime.min.time(), MARKET_TIMEZONE).replace(hour=12))
    with pytest.raises(InvalidRequestError, match="尚未确认"):
        service.synchronize()
    assert fake["calls"] == [] and not service.status()["download_allowed"]


def test_missing_whole_day_is_pending_and_only_retried_in_next_task(container, sync):
    service, fake = sync
    fake["reply"] = lambda start, end, number: page([row(LAST)])
    first = service.synchronize()
    assert first["completed_days"] == 1 and first["pending_days"] == 1
    assert fake["calls"] == [(FIRST, LAST, 1)]
    assert not WudaoRepository(container.database).day(FIRST)[2]
    fake["reply"] = lambda start, end, number: page([row(FIRST)])
    second = service.synchronize()
    assert second["completed_days"] == 2 and second["pending_days"] == 0
    assert fake["calls"][-1] == (FIRST, FIRST, 1)


@pytest.mark.parametrize("legacy_status", ["pending", "complete"])
def test_legacy_intraday_batch_never_counts_as_final_or_resumes_page_two(container, sync, monkeypatch, legacy_status):
    service, fake = sync
    service.synchronize()
    current = date(2026, 10, 26)
    seed_days(container, [current])
    with container.database.session() as conn:
        old_id = conn.execute(
            "INSERT INTO wudao_theme_batch(start_date,end_date,next_page,total,total_pages,status,is_final,updated_at) "
            "VALUES (?,?,2,101,2,?,0,?)", (str(current), str(current), legacy_status, "old"),
        ).lastrowid
        conn.execute("INSERT INTO wudao_theme_page VALUES (?,?,?,?)", (old_id, 1, '{"legacy":true}', "old"))
        conn.execute("INSERT INTO wudao_theme_row VALUES (?,?,?,?,?,?)",
                     (old_id, str(current), "sh.600000", "旧题材", '{"legacy":true}', "2026-10-26T06:00:00+00:00"))
    monkeypatch.setattr(module, "_now", lambda: datetime(2026, 10, 26, 15, 29, tzinfo=MARKET_TIMEZONE))
    fake["calls"].clear()
    with pytest.raises(InvalidRequestError, match="15:30"):
        service.synchronize()
    assert fake["calls"] == []
    monkeypatch.setattr(module, "_now", lambda: datetime(2026, 10, 26, 15, 30, tzinfo=MARKET_TIMEZONE))
    assert service.status()["completed_days"] == 2 and service.status()["pending_days"] == 1
    fake["reply"] = lambda start, end, number: page([row(current, theme="芯片")])
    assert service.synchronize(max_calls=1)["pending_days"] == 0
    assert fake["calls"] == [(current, current, 1)]
    old_batch = next(batch for batch in stored(container, "wudao_theme_batch") if batch["id"] == old_id)
    assert old_batch["status"] == ("superseded" if legacy_status == "pending" else "complete")
    assert old_batch["is_final"] == 0
    assert next(saved for saved in stored(container, "wudao_theme_page") if saved["batch_id"] == old_id)["payload"] == '{"legacy":true}'
    assert stored(container, "wudao_theme_batch")[-1]["is_final"] == 1
    assert WudaoRepository(container.database).is_final(current)


@pytest.mark.parametrize("old_day,allowed_next", [(date(2026, 10, 24), True), (date(2026, 10, 25), False)])
def test_rate_wait_crossing_midnight_rechecks_calendar_before_budget(container, sync, monkeypatch, old_day, allowed_next):
    service, fake = sync
    clock = {"now": datetime.combine(old_day, datetime.min.time(), MARKET_TIMEZONE).replace(hour=23, minute=59, second=59),
             "timestamp": 1000.0}
    monkeypatch.setattr(module, "_now", lambda: clock["now"])
    monkeypatch.setattr(module.time, "time", lambda: clock["timestamp"])

    def sleep(seconds):
        clock["now"] += timedelta(seconds=seconds)
        clock["timestamp"] += seconds

    monkeypatch.setattr(module.time, "sleep", sleep)
    with container.database.session() as conn:
        service.meta.set(conn, f"wudao_usage:{old_day}", json.dumps({"calls": 1, "last_at": 1000.0}))
    result = service.synchronize()
    next_day = old_day + timedelta(days=1)
    assert clock["now"].date() == next_day
    assert json.loads(service.meta.get(f"wudao_usage:{old_day}"))["calls"] == 1
    if allowed_next:
        assert result["calls_today"] == 1 and len(fake["calls"]) == 1
        assert json.loads(service.meta.get(f"wudao_usage:{next_day}"))["calls"] == 1
    else:
        assert result["calls_today"] == 0 and fake["calls"] == []
        assert service.meta.get(f"wudao_usage:{next_day}") is None
        assert "15:30" in result["error"]


def test_rate_wait_entering_free_restriction_does_not_send(container, sync, monkeypatch):
    service, fake = sync
    clock = {"now": datetime(2026, 10, 24, 9, 14, 59, tzinfo=MARKET_TIMEZONE), "timestamp": 1000.0}
    monkeypatch.setattr(module, "_now", lambda: clock["now"])
    monkeypatch.setattr(module.time, "time", lambda: clock["timestamp"])

    def sleep(seconds):
        clock["now"] += timedelta(seconds=seconds)
        clock["timestamp"] += seconds

    monkeypatch.setattr(module.time, "sleep", sleep)
    with container.database.session() as conn:
        service.meta.set(conn, "wudao_usage:2026-10-24", json.dumps({"calls": 1, "last_at": 1000.0}))
    result = service.synchronize()
    assert "09:15" in result["error"] and fake["calls"] == []
    assert result["calls_today"] == 1


def test_existing_pending_page_cannot_resume_during_trading_day(container, sync, monkeypatch):
    service, fake = sync
    rows = [row(code=f"{600000 + index:06}") for index in range(100)]
    fake["reply"] = lambda start, end, number: page(rows, total=101)
    service.synchronize(max_calls=1)
    assert stored(container, "wudao_theme_batch")[0]["next_page"] == 2
    monkeypatch.setattr(module, "_now", lambda: datetime(2026, 10, 26, 12, tzinfo=MARKET_TIMEZONE))
    with pytest.raises(InvalidRequestError, match="15:30"):
        service.synchronize()
    assert len(fake["calls"]) == 1
    assert stored(container, "wudao_theme_batch")[0]["next_page"] == 2
    assert service.meta.get("wudao_usage:2026-10-26") is None


def test_running_task_stops_next_page_at_next_trading_day_midnight(container, sync, monkeypatch):
    service, fake = sync
    clock = {"now": datetime(2026, 10, 25, 23, 59, 59, tzinfo=MARKET_TIMEZONE)}
    monkeypatch.setattr(module, "_now", lambda: clock["now"])

    def reply(start, end, number):
        clock["now"] = datetime(2026, 10, 26, 0, tzinfo=MARKET_TIMEZONE)
        return page([row(code=f"{600000 + index:06}") for index in range(100)], total=101)

    fake["reply"] = reply
    result = service.synchronize()
    assert len(fake["calls"]) == 1 and not result["running"]
    assert "15:30" in result["error"]
    assert service.meta.get("wudao_usage:2026-10-26") is None
    assert json.loads(service.meta.get("wudao_usage:2026-10-25"))["calls"] == 1
    assert stored(container, "wudao_theme_batch")[0]["next_page"] == 2


def test_crossing_blocked_time_after_reservation_refunds_unsent_budget(container, sync, monkeypatch):
    service, fake = sync
    clock = {"now": datetime(2026, 10, 25, 23, 59, 59, tzinfo=MARKET_TIMEZONE)}
    monkeypatch.setattr(module, "_now", lambda: clock["now"])
    write_state = service._write_state

    def progress(**fields):
        write_state(**fields)
        if fields.get("message", "").startswith("正在下载"):
            clock["now"] = datetime(2026, 10, 26, 0, tzinfo=MARKET_TIMEZONE)

    monkeypatch.setattr(service, "_write_state", progress)
    result = service.synchronize()
    assert fake["calls"] == [] and "15:30" in result["error"]
    assert json.loads(service.meta.get("wudao_usage:2026-10-25"))["calls"] == 0
    assert service.meta.get("wudao_usage:2026-10-26") is None


def test_initialization_crossing_into_trading_day_does_not_query_or_spend(container, sync, monkeypatch):
    service, fake = sync
    clock = {"now": datetime(2026, 10, 25, 23, 59, 59, tzinfo=MARKET_TIMEZONE)}
    monkeypatch.setattr(module, "_now", lambda: clock["now"])

    def initialize():
        clock["now"] = datetime(2026, 10, 26, 0, tzinfo=MARKET_TIMEZONE)

    fake["initialize"] = initialize
    result = service.synchronize()
    assert fake["calls"] == [] and fake["closed"] == 1
    assert not result["running"] and "15:30" in result["error"]
    assert json.loads(service.meta.get("wudao_usage:2026-10-25"))["calls"] == 0
    assert service.meta.get("wudao_usage:2026-10-26") is None
    assert stored(container, "wudao_theme_batch")[0]["next_page"] == 1
    assert stored(container, "wudao_theme_page") == [] and stored(container, "wudao_theme_row") == []


def test_background_bootstrap_rechecks_time_before_creating_provider(container, sync, monkeypatch):
    service, fake = sync
    service._claim()
    monkeypatch.setattr(module, "_now", lambda: datetime(2026, 10, 26, 12, tzinfo=MARKET_TIMEZONE))
    service._download(50)
    assert fake["keys"] == [] and fake["calls"] == []
    assert "15:30" in service.status()["error"]
    assert service.meta.get("wudao_usage:2026-10-26") is None


def test_failed_thread_start_releases_claim(container, sync, monkeypatch):
    service, _ = sync

    class FailedThread:
        def __init__(self, **kwargs):
            pass

        def start(self):
            raise RuntimeError("cannot start")

    monkeypatch.setattr(module.threading, "Thread", FailedThread)
    with pytest.raises(RuntimeError):
        service.start()
    result = service.status()
    assert not result["running"] and "无法启动" in result["error"]


def test_cancel_callback_stops_before_next_page_spends_budget(container, sync):
    service, fake = sync
    rows = [row(code=f"{600000 + index:06}") for index in range(100)]
    fake["reply"] = lambda start, end, number: page(rows, total=101)

    def check_cancelled():
        if fake["calls"]:
            raise RuntimeError("cancelled")

    result = service.synchronize(check_cancelled=check_cancelled)
    assert len(fake["calls"]) == 1 and result["calls_today"] == 1
    assert not result["running"] and result["pending_days"] == 2
    assert stored(container, "wudao_theme_batch")[0]["next_page"] == 2


@pytest.fixture()
def api(container, monkeypatch):
    monkeypatch.delenv("WUDAO_API_KEY", raising=False)
    monkeypatch.setattr(module, "_now", lambda: datetime(2026, 10, 24, 18, tzinfo=MARKET_TIMEZONE))
    app = create_app()
    app.state.container = container
    return TestClient(app, client=("127.0.0.1", 50000))


def test_status_and_config_api_do_not_expose_secret(container, api):
    assert api.get("/api/stock-ladder/themes/status").json()["configured"] is False
    response = api.post("/api/stock-ladder/themes/config", json={"api_key": KEY})
    assert response.status_code == 200 and response.json()["configured"] is True
    assert KEY not in response.text
    assert KEY not in api.get("/api/stock-ladder/themes/status").text


def test_sync_api_requires_key_and_validates_budget(container, api, monkeypatch):
    assert api.post("/api/stock-ladder/themes/sync", json={"max_calls": 1}).status_code == 422
    service = container.wudao_theme_service
    service.configure(KEY)
    calls = []
    monkeypatch.setattr(service, "start", lambda maximum: calls.append(maximum) or service.status())
    for limit in (0, 51):
        assert api.post("/api/stock-ladder/themes/sync", json={"max_calls": limit}).status_code == 422
    response = api.post("/api/stock-ladder/themes/sync", json={"max_calls": 12})
    assert response.status_code == 202 and calls == [12]
    assert KEY not in response.text


def test_sync_api_rejects_trading_day_before_claim_and_reports_reason(container, api, monkeypatch):
    service = container.wudao_theme_service
    service.configure(KEY)
    with container.database.session() as conn:
        container.calendar_repository.upsert_days(conn, [(date(2026, 10, 26), True)])
    monkeypatch.setattr(module, "_now", lambda: datetime(2026, 10, 26, 12, tzinfo=MARKET_TIMEZONE))
    response = api.post("/api/stock-ladder/themes/sync", json={"max_calls": 1})
    assert response.status_code == 422 and "15:30" in response.text
    status = api.get("/api/stock-ladder/themes/status").json()
    assert not status["download_allowed"] and "15:30" in status["download_block_reason"]
    assert not status["running"] and status["calls_today"] == 0
    assert service._state() == {}
