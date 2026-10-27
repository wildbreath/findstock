"""涨停池适配、日期边界与页面接口。"""

from dataclasses import replace
from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace

import pandas as pd
import pytest
from fastapi.testclient import TestClient

from app.api.deps import get_container
from app.core.errors import DataNotAvailableError, InvalidRequestError, ProviderError
from app.main import create_app
from app.providers import akshare_provider
from app.providers.akshare_provider import AkshareProvider
from app.repositories.database import SCHEMA_VERSION
from app.services import ladder_service
from app.services.ladder_service import LadderService, MARKET_TIMEZONE

DAY = date(2026, 10, 15)


@pytest.fixture()
def pool(monkeypatch):
    rows = [{
        "代码": "000001", "名称": "测试股票", "连板数": 2,
        "最新价": 12.34, "涨跌幅": 10.03, "成交额": 2e8,
        "换手率": 3.5, "封板资金": 1e8, "首次封板时间": "093005",
        "最后封板时间": "14:00:01", "炸板次数": 1, "所属行业": "软件开发",
    }]
    calls = []

    def fetch(**kwargs):
        calls.append(kwargs)
        return pd.DataFrame(rows)

    monkeypatch.setattr(akshare_provider.ak, "stock_zt_pool_em", fetch)
    return rows, calls, AkshareProvider(max_attempts=1)


def test_pool_preserves_source_units_and_formats(pool):
    rows, calls, provider = pool
    rows.extend([
        dict(rows[0], 代码="688001", 名称="ST测试", 连板数=1, 最新价=float("nan")),
        dict(rows[0], 代码="830001"),
        dict(rows[0], 代码="900001"),
    ])
    items = provider.fetch_limit_up_pool(DAY)
    assert calls == [{"date": "20261015"}]
    assert len(items) == 2
    item = items[0]
    assert (item.code, item.consecutive, item.board) == ("sz.000001", 2, "main_sz")
    assert (item.price, item.amount, item.seal_funds) == (12.34, 2e8, 1e8)
    assert (item.first_seal, item.last_seal) == ("09:30:05", "14:00:01")
    assert items[1].is_st and items[1].price is None and items[1].board == "star"


@pytest.mark.parametrize("value", [None, float("nan"), 0, -1, 1.5, float("inf")])
def test_pool_rejects_invalid_consecutive(pool, value):
    rows, _, provider = pool
    rows[0]["连板数"] = value
    with pytest.raises(ProviderError):
        provider.fetch_limit_up_pool(DAY)


def test_pool_empty_schema_change_and_optional_fields(pool):
    rows, _, provider = pool
    rows[0].update({"封板资金": float("inf"), "首次封板时间": "259999"})
    item = provider.fetch_limit_up_pool(DAY)[0]
    assert item.seal_funds is None and item.first_seal is None
    del rows[0]["连板数"]
    with pytest.raises(ProviderError, match="缺少"):
        provider.fetch_limit_up_pool(DAY)
    rows.clear()
    assert provider.fetch_limit_up_pool(DAY) == []


@pytest.fixture()
def service(pool, monkeypatch, container):
    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return cls(2026, 10, 15, 14, 0, tzinfo=MARKET_TIMEZONE)

    monkeypatch.setattr(ladder_service, "datetime", Clock)
    item = pool[2].fetch_limit_up_pool(DAY)[0]
    provider = SimpleNamespace(
        fetch_trading_calendar=lambda start, end: [
            (DAY, True), (date(2026, 10, 14), True), (date(2026, 10, 11), False),
        ],
        fetch_limit_up_pool=lambda day: [
            replace(item, code="sh.600001", consecutive=1),
            replace(item, code="sh.600002", consecutive=5, first_seal="10:00:00"),
            replace(item, code="sz.000002", consecutive=5, first_seal="09:30:00"),
        ],
        fetch_limit_up_pool_ths=lambda day: [],
    )
    with container.database.session() as conn:
        container.calendar_repository.upsert_days(conn, [
            (DAY, True), (date(2026, 10, 14), True), (date(2026, 10, 11), False),
        ])
    return LadderService(provider, container.database)


def test_snapshot_latest_and_height_order(service):
    result = service.snapshot()
    assert result.trade_date == DAY
    assert result.trading_days == [date(2026, 10, 14), DAY]
    assert [item.code for item in result.items] == ["sz.000002", "sh.600002", "sh.600001"]
    assert result.fetched_at.utcoffset().total_seconds() == 8 * 3600
    service.download_snapshot(date(2026, 10, 14))
    assert service.snapshot(date(2026, 10, 14)).trade_date == date(2026, 10, 14)


@pytest.mark.parametrize("day", [date(2026, 10, 16), date(2026, 10, 11)])
def test_snapshot_rejects_future_old_and_closed_dates(service, day):
    with pytest.raises(InvalidRequestError):
        service.snapshot(day)


def test_snapshot_missing_calendar(service, container):
    with container.database.session() as conn:
        conn.execute("DELETE FROM trading_day")
    service.provider.fetch_trading_calendar = lambda *args: pytest.fail("浏览不得联网初始化日历")
    with pytest.raises(DataNotAvailableError, match="交易日历尚未初始化"):
        service.snapshot()


def test_ladder_api_and_error_contract(container, service):
    service.download_snapshot(date(2026, 10, 14))
    app = create_app()
    container.ladder_service = service
    app.dependency_overrides[get_container] = lambda: container
    client = TestClient(app, client=("127.0.0.1", 50000))
    response = client.get("/api/stock-ladder?date=2026-10-14")
    assert response.status_code == 200
    assert response.json()["trade_date"] == "2026-10-14"
    assert response.json()["items"][0]["consecutive"] == 5
    assert client.get("/api/stock-ladder?date=bad").status_code == 422
    assert client.get("/api/stock-ladder?date=2026-10-11").status_code == 422

    def fail(day):
        raise ProviderError("涨停池暂不可用")

    service.provider.fetch_limit_up_pool = fail
    service.provider.fetch_limit_up_pool_ths = fail
    response = client.get("/api/stock-ladder")
    assert response.status_code == 502
    assert response.json()["error"]["code"] == "provider_error"


def set_clock(monkeypatch, instant):
    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return instant.astimezone(tz) if tz else instant.replace(tzinfo=None)
    monkeypatch.setattr(ladder_service, "datetime", Clock)


def offline(*args):
    raise ProviderError("网络不可用")


def test_archives_survive_restart_and_beyond_online_window(service, monkeypatch):
    day = date(2026, 10, 14)
    original = service.download_snapshot(day)
    assert original.is_final and original.data_source == "eastmoney"
    service.provider.fetch_trading_calendar = offline
    service.provider.fetch_limit_up_pool = offline
    restarted = LadderService(service.provider, service.database)
    stored = restarted.snapshot(day)
    assert stored.data_source == "local" and not stored.stale
    assert stored.items == original.items and stored.fetched_at == original.fetched_at
    set_clock(monkeypatch, datetime(2028, 1, 10, 16, tzinfo=MARKET_TIMEZONE))
    stored = restarted.snapshot(day, refresh=True)
    assert stored.items == original.items and day in stored.trading_days
    assert stored.trading_days == [day]


def test_current_snapshot_expires_but_close_needs_explicit_download(service, monkeypatch):
    calls = []
    fetch = service.provider.fetch_limit_up_pool
    service.provider.fetch_limit_up_pool = lambda day: (calls.append(day), fetch(day))[1]
    intraday = service.snapshot(DAY)
    assert not intraday.is_final
    assert service.snapshot(DAY).data_source == "local"
    assert len(calls) == 1
    set_clock(monkeypatch, datetime(2026, 10, 15, 14, 1, 1, tzinfo=MARKET_TIMEZONE))
    assert service.snapshot(DAY).data_source == "eastmoney"
    assert len(calls) == 2
    service.snapshot(DAY, refresh=True)
    assert len(calls) == 3
    set_clock(monkeypatch, datetime(2026, 10, 15, 15, 20, tzinfo=MARKET_TIMEZONE))
    local = service.snapshot(DAY, refresh=True)
    assert not local.is_final and len(calls) == 3
    set_clock(monkeypatch, datetime(2026, 10, 15, 15, 30, tzinfo=MARKET_TIMEZONE))
    assert not service.snapshot(DAY, refresh=True).is_final and len(calls) == 3
    final = service.download_snapshot(DAY)
    assert final.is_final and len(calls) == 4
    service.provider.fetch_limit_up_pool = offline
    assert service.snapshot(DAY).data_source == "local"


def test_next_day_preserves_unfinished_intraday_snapshot_without_network(service, monkeypatch):
    original = service.snapshot(DAY)
    assert not original.is_final
    set_clock(monkeypatch, datetime(2026, 10, 16, 9, tzinfo=MARKET_TIMEZONE))
    service.provider.fetch_limit_up_pool = lambda *args: pytest.fail("浏览不能自动补最终数据")
    updated = service.snapshot(DAY)
    assert not updated.is_final and updated.data_source == "local"
    assert updated.theme_error == original.theme_error


def test_offline_latest_uses_persisted_calendar_and_snapshot(service, monkeypatch):
    set_clock(monkeypatch, datetime(2026, 10, 15, 16, tzinfo=MARKET_TIMEZONE))
    original = service.download_snapshot(DAY)
    service.provider.fetch_trading_calendar = offline
    service.provider.fetch_limit_up_pool = offline
    set_clock(monkeypatch, datetime(2026, 10, 16, 9, tzinfo=MARKET_TIMEZONE))
    restarted = LadderService(service.provider, service.database)
    latest = restarted.snapshot()
    assert latest.data_source == "local" and latest.items == original.items
    assert latest.trade_date == DAY and not latest.stale


@pytest.mark.parametrize("empty", [False, True])
def test_refresh_failure_or_empty_cannot_erase_saved_data(service, empty):
    day = date(2026, 10, 14)
    original = service.download_snapshot(day)
    service.provider.fetch_limit_up_pool = (lambda day: []) if empty else offline
    fallback = service.download_snapshot(day)
    assert fallback.stale and fallback.data_source == "local"
    assert fallback.items == original.items and fallback.fetched_at == original.fetched_at
    saved = service.repository.get(day)
    assert not saved.stale and saved.items == original.items


def test_empty_result_is_not_a_permanent_archive(service):
    fetch = service.provider.fetch_limit_up_pool
    service.provider.fetch_limit_up_pool = lambda day: []
    assert service.snapshot(DAY).items == []
    assert service.repository.get(DAY) is None and service.repository.dates() == []
    service.provider.fetch_limit_up_pool = fetch
    assert service.snapshot(DAY).items
    assert service.repository.dates() == [DAY]


@pytest.mark.parametrize("invalid", ["not json", "wrong_date", "no_timezone"])
def test_invalid_archive_requires_explicit_download(service, invalid):
    import json
    day = date(2026, 10, 14)
    service.download_snapshot(day)
    with service.database.session() as conn:
        raw = conn.execute("SELECT payload FROM ladder_snapshot WHERE trade_date = ?", (day.isoformat(),)).fetchone()[0]
        data = json.loads(raw)
        if invalid == "wrong_date":
            data["trade_date"] = "2026-10-13"
        if invalid == "no_timezone":
            data["fetched_at"] = "2026-10-15T14:00:00"
        conn.execute("UPDATE ladder_snapshot SET payload = ? WHERE trade_date = ?",
                     (invalid if invalid == "not json" else json.dumps(data), day.isoformat()))
    assert service.repository.get(day) is None
    with pytest.raises(DataNotAvailableError):
        service.snapshot(day, refresh=True)
    assert service.download_snapshot(day).data_source == "eastmoney"
    assert service.repository.get(day).items


def test_late_older_write_does_not_replace_newer_snapshot(service):
    original = service.download_snapshot(date(2026, 10, 14))
    service.repository.save(replace(original, fetched_at=original.fetched_at - timedelta(minutes=1), items=original.items[:1]))
    assert service.repository.get(original.trade_date).items == original.items
    service.repository.save(replace(original, fetched_at=original.fetched_at + timedelta(minutes=1), items=[]))
    assert service.repository.get(original.trade_date).items == original.items


def test_archive_api_refresh_and_fallback(container, service):
    service.download_snapshot(date(2026, 10, 14))
    app = create_app()
    container.ladder_service = service
    app.dependency_overrides[get_container] = lambda: container
    client = TestClient(app, client=("127.0.0.1", 50000))
    url = "/api/stock-ladder?date=2026-10-14"
    first = client.get(url).json()
    assert first["data_source"] == "local" and first["is_final"]
    stored = client.get(url).json()
    assert stored["data_source"] == "local" and stored["fetched_at"] == first["fetched_at"]
    assert client.get(url + "&refresh=true").json()["data_source"] == "local"
    service.provider.fetch_limit_up_pool = offline
    fallback = client.get(url + "&refresh=true")
    assert fallback.status_code == 200 and not fallback.json()["stale"]
    assert fallback.json()["items"] == first["items"]
    assert client.get(url + "&refresh=invalid").status_code == 422


def test_ladder_table_migrates_existing_database_idempotently(container):
    with container.database.session() as conn:
        conn.execute("DROP TABLE ladder_snapshot")
        conn.execute("DELETE FROM schema_version WHERE version = ?", (SCHEMA_VERSION,))
        conn.execute("INSERT INTO schema_version VALUES (4, '2026-10-14T00:00:00+00:00')")
        conn.execute("INSERT INTO meta VALUES ('archive_migration_sentinel', 'keep', '2026-10-14')")
    container.database.initialize()
    container.database.initialize()
    with container.database.session() as conn:
        assert conn.execute("SELECT COUNT(*) FROM ladder_snapshot").fetchone()[0] == 0
        assert conn.execute(
            "SELECT COUNT(*) FROM schema_version WHERE version = ?", (SCHEMA_VERSION,)
        ).fetchone()[0] == 1
        assert conn.execute("SELECT value FROM meta WHERE key = 'archive_migration_sentinel'").fetchone()[0] == "keep"


def test_sector_candidates_use_sixty_sessions_and_four_board_threshold(service, container, monkeypatch):
    from app.domain.ladder import LadderSnapshot

    calendar = [DAY - timedelta(days=offset) for offset in range(120, -1, -1)
                if (DAY - timedelta(days=offset)).weekday() < 5]
    with container.database.session() as conn:
        container.calendar_repository.upsert_days(conn, [(day, True) for day in calendar])
    service.provider.fetch_trading_calendar = lambda start, end: [(day, True) for day in calendar]
    item = service.provider.fetch_limit_up_pool(DAY)[0]

    def save(day, items):
        service.repository.save(LadderSnapshot(day, calendar, datetime(2026, 10, 15, 14, tzinfo=MARKET_TIMEZONE), items))

    save(calendar[-61], [replace(item, code="sh.600010", consecutive=9)])
    save(calendar[-60], [replace(item, code="sh.600011", consecutive=4)])
    save(calendar[-2], [replace(item, code="sh.600011", consecutive=5), replace(item, code="sz.000023", consecutive=3)])
    save(DAY, [replace(item, code="sz.000024", consecutive=4), replace(item, code="sh.600025", consecutive=4, is_st=True)])
    tomorrow = DAY + timedelta(days=1)
    save(tomorrow, [replace(item, code="sh.600026", consecutive=9)])
    result = service.sector_candidates()
    assert result.trading_days == calendar[-60:]
    assert result.covered_dates == [calendar[-60], calendar[-2], DAY]
    assert result.codes == ["sh.600011", "sh.600025", "sz.000024"]
    assert len(result.trading_days) == 60 and len(result.covered_dates) == 3

    # 离线时使用本地完整日历, 缺失存档不移动窗口边界。
    with container.database.session() as conn:
        container.calendar_repository.upsert_days(conn, [(day, True) for day in calendar])
    service.provider.fetch_trading_calendar = offline
    service.provider.fetch_limit_up_pool = offline
    assert service.sector_candidates() == result
    set_clock(monkeypatch, datetime(2026, 10, 16, 14, tzinfo=MARKET_TIMEZONE))
    rolled = service.sector_candidates()
    assert rolled.trading_days[-1] == tomorrow and rolled.trading_days[0] == calendar[-59]
    assert "sh.600026" in rolled.codes


def test_sector_candidates_api_reports_partial_archive_coverage(container, service):
    service.download_snapshot(date(2026, 10, 14))
    app = create_app()
    container.ladder_service = service
    app.dependency_overrides[get_container] = lambda: container
    body = TestClient(app, client=("127.0.0.1", 50000)).get("/api/stock-ladder/sector-candidates").json()
    assert body["trading_days"] == ["2026-10-14", "2026-10-15"]
    assert body["covered_dates"] == ["2026-10-14"]
    assert body["codes"] == ["sh.600002", "sz.000002"]


def test_historical_ths_source_persists_across_restart(service, container):
    old_day = date(2025, 10, 16)
    item = service.provider.fetch_limit_up_pool(DAY)[0]
    service.provider.fetch_trading_calendar = lambda start, end: [(old_day, True), (DAY, True)]
    service.provider.fetch_limit_up_pool = lambda day: pytest.fail("旧日期不应请求东方财富")
    service.provider.fetch_limit_up_pool_ths = lambda day: [item]
    with container.database.session() as conn:
        container.calendar_repository.upsert_days(conn, [(old_day, True)])
    snapshot = service.download_snapshot(old_day)
    assert snapshot.origin == snapshot.data_source == "ths" and snapshot.is_final
    local = LadderService(service.provider, service.database).snapshot(old_day)
    assert local.data_source == "local" and local.origin == "ths" and local.items == [item]


@pytest.mark.parametrize("empty", [True, False])
def test_recent_pool_falls_back_to_ths(service, empty):
    item = service.provider.fetch_limit_up_pool(DAY)[0]
    service.provider.fetch_limit_up_pool = (lambda day: []) if empty else offline
    service.provider.fetch_limit_up_pool_ths = lambda day: [item]
    assert service.download_snapshot(date(2026, 10, 14)).origin == "ths"


def test_backfill_reuses_final_and_reports_gaps(service, monkeypatch):
    from app.cli.ladder import backfill
    set_clock(monkeypatch, datetime(2026, 10, 16, 16, tzinfo=MARKET_TIMEZONE))
    monkeypatch.setattr("app.cli.ladder.datetime", ladder_service.datetime)
    monkeypatch.setattr("app.cli.ladder.time.sleep", lambda seconds: None)
    day = date(2026, 10, 14)
    service.download_snapshot(day)
    service.provider.fetch_limit_up_pool = lambda day: []
    report = backfill(service, day, DAY, progress=lambda line: None)
    assert report["reused_dates"] == [day.isoformat()]
    assert report["expected_days"] == 2 and report["missing_dates"] == [DAY.isoformat()]
    assert not report["passed"] and DAY.isoformat() in report["failures"]


def save_wudao_themes(container, start, end, entries, *, complete=True, is_final=True):
    timestamp = "2026-10-15T16:00:00+08:00"
    with container.database.session() as conn:
        batch = conn.execute(
            "INSERT INTO wudao_theme_batch (start_date, end_date, status, updated_at, is_final) "
            "VALUES (?, ?, ?, ?, ?)",
            (start.isoformat(), end.isoformat(), "complete" if complete else "pending", timestamp, is_final),
        ).lastrowid
        conn.executemany(
            "INSERT INTO wudao_theme_row "
            "(batch_id, trade_date, code, primary_theme, payload, fetched_at) "
            "VALUES (?, ?, ?, ?, '{}', ?)",
            [(batch, day.isoformat(), code, theme, timestamp) for day, code, theme in entries],
        )


def test_wudao_primary_theme_is_per_day_and_does_not_rewrite_original_archive(service, container):
    previous = date(2026, 10, 14)
    original = service.download_snapshot(previous)
    codes = [item.code for item in original.items]
    save_wudao_themes(container, previous, DAY, [
        (day, code, theme) for day, theme in [(previous, "机器人"), (DAY, "并购重组")]
        for code in codes
    ])
    yesterday = service.snapshot(previous)
    today = service.snapshot(DAY)
    assert {item.primary_theme for item in yesterday.items} == {"机器人"}
    assert {item.primary_theme for item in today.items} == {"并购重组"}
    assert yesterday.theme_complete and yesterday.theme_is_final and yesterday.theme_error is None
    assert yesterday.origin == original.origin and yesterday.is_final == original.is_final
    assert yesterday.fetched_at == original.fetched_at
    assert all(item.primary_theme is None for item in service.repository.get(previous).items)


def test_missing_wudao_theme_does_not_fall_back_to_industry_or_stale_snapshot_theme(service):
    day = date(2026, 10, 14)
    original = service.download_snapshot(day)
    service.repository.save(replace(original, items=[
        replace(item, primary_theme="旧分类") for item in original.items
    ]))
    result = service.snapshot(day)
    assert all(item.industry == "软件开发" and item.primary_theme is None for item in result.items)
    assert not result.theme_complete and not result.theme_is_final
    assert result.theme_fetched_at is None and "尚未下载" in result.theme_error


def test_partial_wudao_page_is_visible_but_not_marked_complete(service, container):
    day = date(2026, 10, 14)
    original = service.download_snapshot(day)
    save_wudao_themes(container, day, day, [(day, original.items[0].code, "机器人")], complete=False)
    result = service.snapshot(day)
    assert result.items[0].primary_theme == "机器人"
    assert all(item.primary_theme is None for item in result.items[1:])
    assert result.theme_fetched_at is not None
    assert not result.theme_complete and not result.theme_is_final
    assert "分页" in result.theme_error


def test_completed_download_with_unmatched_stocks_reports_count(service, container):
    day = date(2026, 10, 14)
    original = service.download_snapshot(day)
    save_wudao_themes(container, day, day, [(day, original.items[0].code, "机器人")])
    result = service.snapshot(day)
    assert result.theme_is_final and not result.theme_complete
    assert result.theme_error == "悟道题材未匹配 2 只股票"


def test_legacy_intraday_wudao_classification_is_not_shown(service, container):
    original = service.snapshot(DAY)
    save_wudao_themes(container, DAY, DAY,
                      [(DAY, item.code, "机器人") for item in original.items], is_final=False)
    result = service.snapshot(DAY)
    assert not result.theme_complete and not result.theme_is_final
    assert all(item.primary_theme is None for item in result.items)
    assert "尚未下载" in result.theme_error
    assert not result.is_final


def test_complete_range_cannot_mark_an_entire_missing_day_downloaded(service, container):
    previous = date(2026, 10, 14)
    original = service.download_snapshot(previous)
    service.snapshot(DAY)
    save_wudao_themes(container, previous, DAY,
                      [(previous, item.code, "机器人") for item in original.items])
    result = service.snapshot(DAY)
    assert not result.theme_complete and not result.theme_is_final
    assert result.theme_fetched_at is None and "尚未下载" in result.theme_error
    assert all(item.primary_theme is None for item in result.items)
    assert service.theme_candidates(previous).classified_dates == [previous]
    assert service.theme_candidates().classified_dates == []


@pytest.mark.parametrize("empty", [True, False])
def test_pool_refresh_fallback_still_reads_local_wudao_themes(service, container, empty):
    day = date(2026, 10, 14)
    original = service.download_snapshot(day)
    save_wudao_themes(container, day, day, [(day, item.code, "机器人") for item in original.items])
    service.provider.fetch_limit_up_pool = (lambda day: []) if empty else offline
    result = service.snapshot(day, refresh=True)
    assert not result.stale and result.theme_complete
    assert {item.primary_theme for item in result.items} == {"机器人"}


def test_wudao_theme_read_and_candidates_are_available_without_network_or_key(service, container):
    day = date(2026, 10, 14)
    original = service.download_snapshot(day)
    save_wudao_themes(container, day, day, [(day, item.code, "机器人") for item in original.items])
    service.provider.fetch_trading_calendar = lambda *args: pytest.fail("题材读取不能请求远程日历")
    service.provider.fetch_limit_up_pool = lambda *args: pytest.fail("已有完整股池不能重新下载")
    result = service.snapshot(day)
    assert result.theme_complete
    candidates = service.theme_candidates(day)
    assert candidates.trade_date == day
    assert candidates.covered_dates == candidates.classified_dates == [day]
    assert [(theme.name, theme.stock_count) for theme in candidates.themes] == [("机器人", 3)]
    assert candidates.unclassified_count == 0


def test_wudao_theme_candidates_use_only_selected_day_and_all_heights(service, container):
    from app.domain.ladder import LadderSnapshot

    calendar = [DAY - timedelta(days=offset) for offset in range(120, -1, -1)
                if (DAY - timedelta(days=offset)).weekday() < 5]
    with container.database.session() as conn:
        container.calendar_repository.upsert_days(conn, [(day, True) for day in calendar])
    base = service.provider.fetch_limit_up_pool(DAY)[0]
    datasets = [
        (calendar[-61], [("sh.600010", 9, "过期题材")]),
        (calendar[-60], [("sh.600011", 4, "机器人")]),
        (calendar[-2], [("sh.600011", 5, "机器人"), ("sh.600012", 4, "并购重组"),
                        ("sh.600013", 1, "芯片"), ("sh.600015", 2, "芯片")]),
        (DAY, [("sh.600011", 6, "并购重组"), ("sh.600014", 1, None)]),
    ]
    for day, entries in datasets:
        service.repository.save(LadderSnapshot(
            day, calendar, datetime(2026, 10, 15, 16, tzinfo=MARKET_TIMEZONE),
            [replace(base, code=code, consecutive=height) for code, height, _ in entries],
            is_final=True,
        ))
        save_wudao_themes(container, day, day, [(day, code, theme) for code, _, theme in entries])
    service.provider.fetch_trading_calendar = lambda *args: pytest.fail("统计只应读取本地")
    service.provider.fetch_limit_up_pool = lambda *args: pytest.fail("候选题材不得联网下载股池")
    service.provider.fetch_limit_up_pool_ths = service.provider.fetch_limit_up_pool
    result = service.theme_candidates()
    assert result.trade_date == DAY
    assert result.trading_days == calendar
    assert result.covered_dates == [DAY] and not result.classified_dates
    assert [(theme.name, theme.stock_count) for theme in result.themes] == [("并购重组", 1)]
    assert result.unclassified_count == 1
    previous = service.theme_candidates(calendar[-2])
    assert previous.trade_date == calendar[-2]
    assert previous.covered_dates == previous.classified_dates == [calendar[-2]]
    assert [(theme.name, theme.stock_count) for theme in previous.themes] == [
        ("芯片", 2), ("并购重组", 1), ("机器人", 1),
    ]
    assert previous.unclassified_count == 0
    oldest = service.theme_candidates(calendar[-61])
    assert [(theme.name, theme.stock_count) for theme in oldest.themes] == [("过期题材", 1)]


def test_wudao_candidates_missing_selected_day_never_borrow_other_dates(service, container):
    previous = date(2026, 10, 14)
    original = service.download_snapshot(previous)
    save_wudao_themes(container, previous, previous,
                      [(previous, item.code, "机器人") for item in original.items])
    block_all_provider_calls(service)
    result = service.theme_candidates(DAY)
    assert result.trade_date == DAY and result.trading_days == [previous, DAY]
    assert not result.themes and not result.covered_dates and not result.classified_dates
    assert result.unclassified_count == 0
    assert service.theme_candidates() == result


@pytest.mark.parametrize("day", [date(2026, 10, 16), date(2026, 10, 11)])
def test_wudao_candidates_reject_future_and_closed_dates_without_network(service, day):
    block_all_provider_calls(service)
    with pytest.raises(InvalidRequestError):
        service.theme_candidates(day)


def test_wudao_candidates_reject_unknown_local_date(service):
    block_all_provider_calls(service)
    with pytest.raises(DataNotAvailableError, match="本地没有该日"):
        service.theme_candidates(date(2026, 10, 13))


def test_wudao_theme_candidates_api_uses_date_parameter_and_local_all_height_counts(container, service):
    previous = date(2026, 10, 14)
    original = service.download_snapshot(previous)
    save_wudao_themes(container, previous, previous,
                      [(previous, item.code, "机器人") for item in original.items])
    app = create_app()
    container.ladder_service = service
    app.dependency_overrides[get_container] = lambda: container
    block_all_provider_calls(service)
    client = TestClient(app, client=("127.0.0.1", 50000))
    body = client.get("/api/stock-ladder/theme-candidates?date=2026-10-14").json()
    assert body["trade_date"] == "2026-10-14"
    assert body["covered_dates"] == body["classified_dates"] == ["2026-10-14"]
    assert body["themes"] == [{"name": "机器人", "stock_count": 3}]
    latest = client.get("/api/stock-ladder/theme-candidates")
    assert latest.status_code == 200
    assert latest.json()["trade_date"] == "2026-10-15" and latest.json()["themes"] == []
    assert client.get("/api/stock-ladder/theme-candidates?date=bad").status_code == 422
    assert client.get("/api/stock-ladder/theme-candidates?date=2026-10-16").status_code == 422
    assert client.get("/api/stock-ladder/theme-candidates?date=2026-10-11").status_code == 422
    assert client.get("/api/stock-ladder/theme-candidates?date=2026-10-13").status_code == 409


def block_all_provider_calls(service):
    def blocked(*args, **kwargs):
        pytest.fail("当前浏览入口不允许访问任何外部数据源")
    service.provider.fetch_trading_calendar = blocked
    service.provider.fetch_limit_up_pool = blocked
    service.provider.fetch_limit_up_pool_ths = blocked


@pytest.mark.parametrize("cached", [True, False])
def test_realtime_fallback_cannot_start_after_close(service, monkeypatch, cached):
    original = service.snapshot(DAY) if cached else None

    def slow_primary(day):
        set_clock(monkeypatch, datetime(2026, 10, 15, 15, 0, tzinfo=MARKET_TIMEZONE))
        raise ProviderError("盘中请求结束时已收盘")

    service.provider.fetch_limit_up_pool = slow_primary
    service.provider.fetch_limit_up_pool_ths = lambda day: pytest.fail("收盘后不能发起备用请求")
    if cached:
        result = service.snapshot(DAY, refresh=True)
        assert result.items == original.items and result.data_source == "local"
    else:
        with pytest.raises(DataNotAvailableError, match="交易时段"):
            service.snapshot(DAY, refresh=True)


def test_successful_inflight_response_is_saved_and_read_locally_after_close(service, monkeypatch):
    fetch = service.provider.fetch_limit_up_pool

    def slow_primary(day):
        result = fetch(day)
        set_clock(monkeypatch, datetime(2026, 10, 15, 15, 0, tzinfo=MARKET_TIMEZONE))
        return result

    service.provider.fetch_limit_up_pool = slow_primary
    result = service.snapshot(DAY)
    assert result.data_source == "local" and not result.is_final
    assert service.repository.get(DAY).items == result.items


def test_provider_cannot_retry_a_request_blocked_by_realtime_guard(monkeypatch):
    calls = []
    provider = AkshareProvider(max_attempts=3, backoff_seconds=0)

    def closed():
        calls.append(True)
        raise DataNotAvailableError("已收盘")

    with pytest.raises(DataNotAvailableError):
        provider._call("实时请求", closed)
    assert calls == [True]


@pytest.mark.parametrize("hour, minute", [(8, 0), (9, 14), (11, 30), (12, 30),
                                        (15, 0), (15, 10), (15, 30), (16, 0)])
@pytest.mark.parametrize("refresh", [False, True])
def test_current_day_browsing_outside_trading_sessions_never_goes_online(service, monkeypatch, hour, minute, refresh):
    original = service.snapshot(DAY)
    block_all_provider_calls(service)
    set_clock(monkeypatch, datetime(2026, 10, 15, hour, minute, tzinfo=MARKET_TIMEZONE))
    result = service.snapshot(DAY, refresh=refresh)
    assert result.items == original.items and result.data_source == "local"
    assert not result.is_final and result.theme_error == original.theme_error


@pytest.mark.parametrize("refresh", [False, True])
@pytest.mark.parametrize("hour", [9, 14, 16])
def test_historical_day_browsing_never_goes_online_even_during_today_session(service, monkeypatch, refresh, hour):
    day = date(2026, 10, 14)
    original = service.download_snapshot(day)
    block_all_provider_calls(service)
    set_clock(monkeypatch, datetime(2026, 10, 15, hour, 30, tzinfo=MARKET_TIMEZONE))
    result = service.snapshot(day, refresh=refresh)
    assert result.items == original.items and result.is_final and result.data_source == "local"


@pytest.mark.parametrize("hour, minute", [(9, 15), (11, 29), (13, 0), (14, 59)])
@pytest.mark.parametrize("refresh", [False, True])
def test_current_day_with_confirmed_local_open_calendar_can_fetch_realtime(service, monkeypatch, hour, minute, refresh):
    set_clock(monkeypatch, datetime(2026, 10, 15, hour, minute, tzinfo=MARKET_TIMEZONE))
    service.provider.fetch_trading_calendar = lambda *args: pytest.fail("实时股池也不得查询远程日历")
    calls = []
    fetch = service.provider.fetch_limit_up_pool
    service.provider.fetch_limit_up_pool = lambda day: (calls.append(day), fetch(day))[1]
    result = service.snapshot(DAY, refresh=refresh)
    assert calls == [DAY] and result.data_source == "eastmoney" and not result.is_final


@pytest.mark.parametrize("refresh", [False, True])
def test_today_without_local_open_confirmation_requires_download(service, container, refresh):
    with container.database.session() as conn:
        conn.execute("DELETE FROM trading_day WHERE trade_date=?", (DAY.isoformat(),))
        service.meta.set(conn, "stock_ladder_calendar:v1", '["2026-10-15", ["2026-10-14", "2026-10-15"]]')
    block_all_provider_calls(service)
    with pytest.raises(DataNotAvailableError, match="数据页面下载"):
        service.snapshot(DAY, refresh=refresh)


@pytest.mark.parametrize("refresh", [False, True])
def test_nontrading_day_cannot_fetch_realtime(service, container, refresh):
    original = service.snapshot(DAY)
    with container.database.session() as conn:
        container.calendar_repository.upsert_days(conn, [(DAY, False)])
    block_all_provider_calls(service)
    result = service.snapshot(DAY, refresh=refresh)
    assert result.items == original.items and result.data_source == "local"


@pytest.mark.parametrize("refresh", [False, True])
def test_missing_historical_archive_is_reported_without_network(service, refresh):
    block_all_provider_calls(service)
    day = date(2026, 10, 14)
    with pytest.raises(DataNotAvailableError, match="数据页面下载") as exc:
        service.snapshot(day, refresh=refresh)
    assert exc.value.missing_dates == (day,) and service.repository.get(day) is None


@pytest.mark.parametrize("instant, realtime", [
    (datetime(2026, 10, 15, 6, 0, tzinfo=timezone.utc), True),
    (datetime(2026, 10, 15, 7, 0, tzinfo=timezone.utc), False),
    (datetime(2026, 10, 14, 17, 0, tzinfo=timezone(timedelta(hours=-7))), False),
])
def test_browsing_uses_beijing_sessions_for_other_timezone_instants(service, monkeypatch, instant, realtime):
    original = service.snapshot(DAY)
    set_clock(monkeypatch, instant)
    if realtime:
        calls = []
        fetch = service.provider.fetch_limit_up_pool
        service.provider.fetch_limit_up_pool = lambda day: (calls.append(day), fetch(day))[1]
        result = service.snapshot(DAY, refresh=True)
        assert calls == [DAY] and result.data_source == "eastmoney"
    else:
        block_all_provider_calls(service)
        result = service.snapshot(DAY, refresh=True)
        assert result.data_source == "local" and result.items == original.items


@pytest.mark.parametrize("hour, minute", [(9, 0), (14, 59), (15, 0), (15, 29)])
def test_explicit_today_download_waits_until_1530(service, monkeypatch, hour, minute):
    block_all_provider_calls(service)
    set_clock(monkeypatch, datetime(2026, 10, 15, hour, minute, tzinfo=MARKET_TIMEZONE))
    with pytest.raises(InvalidRequestError, match="15:30"):
        service.download_snapshot(DAY)


def test_explicit_download_requires_local_trading_calendar(service, container):
    block_all_provider_calls(service)
    day = date(2026, 10, 14)
    with container.database.session() as conn:
        conn.execute("DELETE FROM trading_day WHERE trade_date=?", (day.isoformat(),))
    with pytest.raises(DataNotAvailableError, match="交易日历"):
        service.download_snapshot(day)


def test_explicit_historical_download_saves_final_pool_without_remote_calendar(service):
    service.provider.fetch_trading_calendar = lambda *args: pytest.fail("下载股池前日历应已在本地")
    day = date(2026, 10, 14)
    result = service.download_snapshot(day)
    assert result.is_final and result.data_source == "eastmoney"
    assert service.repository.get(day) == result
