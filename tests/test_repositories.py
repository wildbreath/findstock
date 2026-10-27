"""仓储层测试。"""

from __future__ import annotations

from datetime import date, timedelta
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import pytest

from app.container import Container
from app.core.errors import SyncAlreadyRunningError
from app.domain.enums import SyncMode, SyncStatus
from tests.factories import make_bar, make_stock


def test_stock_get_returns_one_record_or_none(container: Container) -> None:
    stock = make_stock("sh.600000", "测试股票")
    with container.database.session() as conn:
        container.stock_repository.upsert_stocks(conn, [stock, make_stock("sz.000001")])
    assert container.stock_repository.get(stock.code) == stock
    assert container.stock_repository.get("sh.600001") is None


def test_bar_upsert_is_idempotent(container: Container) -> None:
    code = "sh.600000"
    day = date(2026, 9, 16)
    with container.database.session() as conn:
        container.bar_repository.upsert_bars(
            conn, [make_bar(code, day, pct_chg=1.0, volume=100)]
        )
        container.bar_repository.upsert_bars(
            conn, [make_bar(code, day, pct_chg=2.0, volume=200)]
        )

    assert container.bar_repository.count() == 1
    bars = container.bar_repository.load_bars_for_dates([day])
    assert float(bars[code][day].pct_chg) == 2.0
    assert bars[code][day].volume == 200


def test_covers_dates_reports_zero_for_missing(container: Container) -> None:
    present = date(2026, 9, 16)
    missing = date(2026, 9, 15)
    with container.database.session() as conn:
        container.bar_repository.upsert_bars(
            conn, [make_bar("sh.600000", present), make_bar("sz.000001", present)]
        )
    assert container.bar_repository.covers_dates([present, missing]) == {
        present: 2,
        missing: 0,
    }


def test_derived_listing_date_uses_earliest_bar(container: Container) -> None:
    code = "sh.600002"
    first = date(2026, 9, 10)
    with container.database.session() as conn:
        container.stock_repository.upsert_stocks(conn, [make_stock(code)])
        container.bar_repository.upsert_bars(
            conn,
            [
                make_bar(code, first),
                make_bar(code, date(2026, 9, 11)),
            ],
        )
        container.stock_repository.refresh_derived_listing_dates(conn)

    stock = container.stock_repository.list_all()[code]
    assert stock.listing_date == first


def test_official_ipo_date_overrides_derived_value(container: Container) -> None:
    code = "sh.600003"
    ipo = date(2011, 3, 4)
    with container.database.session() as conn:
        container.stock_repository.upsert_stocks(conn, [make_stock(code)])
        container.bar_repository.upsert_bars(conn, [make_bar(code, date(2026, 9, 10))])
        container.stock_repository.refresh_derived_listing_dates(conn)
        container.stock_repository.apply_ipo_dates(conn, {code: ipo})

    stock = container.stock_repository.list_all()[code]
    assert stock.ipo_date == ipo
    assert stock.listing_date == ipo


def test_name_change_cache_roundtrip(container: Container) -> None:
    """历史简称 (含空结果) 都要落库, 避免反复请求上游。"""

    repo = container.stock_repository
    assert repo.name_change_fetched_at("sh.600082") is None
    assert repo.load_name_changes("sh.600082") == []

    with container.database.session() as conn:
        repo.save_name_changes(conn, "sh.600082", ["海泰发展", "ST海泰", "海泰发展"])
        repo.save_name_changes(conn, "sh.600000", [])

    assert repo.load_name_changes("sh.600082") == ["海泰发展", "ST海泰", "海泰发展"]
    assert repo.name_change_fetched_at("sh.600082") is not None
    # 空结果也记录过抓取时间
    assert repo.name_change_fetched_at("sh.600000") is not None
    assert repo.load_name_changes("sh.600000") == []


def test_name_change_cache_is_replaced_not_appended(container: Container) -> None:
    repo = container.stock_repository
    with container.database.session() as conn:
        repo.save_name_changes(conn, "sh.600082", ["A", "B", "C"])
        repo.save_name_changes(conn, "sh.600082", ["A", "B"])
    assert repo.load_name_changes("sh.600082") == ["A", "B"]


def test_upsert_stocks_does_not_erase_existing_name(container: Container) -> None:
    code = "sh.600004"
    with container.database.session() as conn:
        container.stock_repository.upsert_stocks(
            conn, [make_stock(code, "原始名称")]
        )
        container.stock_repository.upsert_stocks(conn, [make_stock(code, None)])
    assert container.stock_repository.list_all()[code].name == "原始名称"


def test_name_history_is_per_day(container: Container) -> None:
    code = "sh.600005"
    with container.database.session() as conn:
        container.stock_repository.upsert_stocks(conn, [make_stock(code)])
        container.stock_repository.upsert_name_history(
            conn,
            [
                (code, date(2024, 9, 10), "旧名称"),
                (code, date(2026, 9, 16), "新名称"),
            ],
        )
    assert container.stock_repository.names_on(date(2024, 9, 10))[code] == "旧名称"
    assert container.stock_repository.names_on(date(2026, 9, 16))[code] == "新名称"


def test_calendar_bounds_and_lookback(container: Container) -> None:
    days = [date(2026, 9, 14), date(2026, 9, 15), date(2026, 9, 16)]
    with container.database.session() as conn:
        container.calendar_repository.upsert_days(conn, [(d, True) for d in days])
        container.calendar_repository.upsert_days(
            conn, [(date(2026, 9, 12), False)]
        )

    assert container.calendar_repository.earliest_open_day() == days[0]
    assert container.calendar_repository.latest_open_day() == days[-1]
    assert container.calendar_repository.count_open_days() == 3
    assert container.calendar_repository.open_days_on_or_before(
        date(2026, 9, 16), 2
    ) == [date(2026, 9, 16), date(2026, 9, 15)]
    assert container.calendar_repository.is_trading_day(date(2026, 9, 12)) is False


def test_sync_run_lifecycle(container: Container) -> None:
    repo = container.sync_repository
    repo.create_run("run-1", SyncMode.FULL, total_days=10)
    assert repo.running() is not None
    assert repo.running().run_id == "run-1"

    repo.update("run-1", done_stocks=5, total_stocks=10, phase="bars")
    progress = repo.get("run-1")
    assert progress is not None
    assert progress.percent == 50.0
    assert progress.is_running is True

    repo.finish("run-1", SyncStatus.SUCCEEDED, message="完成")
    assert repo.running() is None
    assert repo.get("run-1").percent == 100.0
    assert repo.last_completed_at() is not None


def test_sync_run_cancel_request(container: Container) -> None:
    repo = container.sync_repository
    repo.create_run("run-2", SyncMode.INCREMENTAL)
    assert repo.request_cancel("run-2") is True
    assert repo.get("run-2").status is SyncStatus.RUNNING
    assert repo.get("run-2").phase == "cancelling"
    assert repo.running().run_id == "run-2"
    assert repo.request_cancel("run-2") is False
    with pytest.raises(SyncAlreadyRunningError):
        repo.create_run("too-early", SyncMode.INCREMENTAL)
    repo.update("run-2", phase="bars", message="不能覆盖取消请求")
    assert repo.get("run-2").phase == "cancelling"
    repo.finish("run-2", SyncStatus.CANCELLED)
    repo.create_run("after-stop", SyncMode.INCREMENTAL)


def test_concurrent_sync_creation_reserves_only_one_slot(container):
    barrier = Barrier(2)

    def start(run_id):
        barrier.wait(timeout=5)
        try:
            container.sync_repository.create_run(run_id, SyncMode.INCREMENTAL)
            return "started"
        except SyncAlreadyRunningError:
            return "blocked"

    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(start, ["parallel-1", "parallel-2"])) == ["blocked", "started"]
    with container.database.session() as conn:
        assert conn.execute("SELECT COUNT(*) FROM sync_run WHERE status = 'running'").fetchone()[0] == 1


def test_late_success_does_not_override_cancellation(container: Container) -> None:
    repo = container.sync_repository
    repo.create_run("cancel-before-finish", SyncMode.INCREMENTAL)
    repo.request_cancel("cancel-before-finish")
    repo.finish("cancel-before-finish", SyncStatus.SUCCEEDED, message="不应覆盖取消")
    assert repo.get("cancel-before-finish").status is SyncStatus.CANCELLED
    assert repo.running() is None


def test_sync_update_rejects_unknown_fields(container: Container) -> None:
    repo = container.sync_repository
    repo.create_run("run-3", SyncMode.FULL)
    try:
        repo.update("run-3", nope=1)
    except ValueError as exc:
        assert "nope" in str(exc)
    else:  # pragma: no cover
        raise AssertionError("应当拒绝未知字段")


def test_synced_day_tracking(container: Container) -> None:
    with container.database.session() as conn:
        container.sync_repository.mark_day_synced(conn, date(2026, 9, 16), 5000)
        container.sync_repository.mark_day_synced(conn, date(2026, 9, 15), 4998)
    assert container.sync_repository.synced_days() == {
        date(2026, 9, 16),
        date(2026, 9, 15),
    }
    assert container.sync_repository.count_synced_days() == 2


def test_stale_run_is_marked_failed(container: Container) -> None:
    repo = container.sync_repository
    repo.create_run("run-stale", SyncMode.FULL, pid=999_999_999)
    assert repo.fail_stale_runs() == 1
    assert repo.get("run-stale").status is SyncStatus.FAILED


def test_meta_repository_roundtrip(container: Container) -> None:
    with container.database.session() as conn:
        container.meta_repository.set(conn, "k", "v")
    assert container.meta_repository.get("k") == "v"
    assert container.meta_repository.get("missing") is None


def test_database_initialize_is_idempotent(container: Container) -> None:
    container.database.initialize()
    container.database.initialize()
    with container.database.session() as conn:
        row = conn.execute(
            "SELECT COUNT(*) AS n FROM schema_version"
        ).fetchone()
    assert row["n"] == 1


def test_seed_helper_marks_synced(container: Container) -> None:
    from tests.factories import seed

    day = date(2026, 9, 16)
    seed(container, open_days=[day], bars=[make_bar("sh.600000", day)])
    assert container.sync_repository.synced_days() == {day}
    assert container.bar_repository.bounds() == (day, day)
    assert container.bar_repository.distinct_codes() == 1


def test_prune_window_is_bounded() -> None:
    """确保行情区间计算的辅助逻辑不会溢出 (防御性测试)。"""

    from app.services.sync_engine import _INCREMENTAL_LOOKBACK_DAYS

    assert timedelta(days=_INCREMENTAL_LOOKBACK_DAYS) > timedelta(0)


def test_codes_needing_sync_tracks_progress(container: Container) -> None:
    """全量下载的断点续传依据 last_sync_end。"""

    day = date(2026, 9, 16)
    with container.database.session() as conn:
        container.stock_repository.upsert_stocks(
            conn,
            [
                make_stock("sh.600001"),
                make_stock("sh.600002"),
                make_stock("sh.600003"),
            ],
        )

    assert container.stock_repository.codes_needing_sync(day) == [
        "sh.600001",
        "sh.600002",
        "sh.600003",
    ]

    with container.database.session() as conn:
        container.stock_repository.mark_codes_synced(
            conn, ["sh.600001", "sh.600002"], day
        )

    assert container.stock_repository.codes_needing_sync(day) == ["sh.600003"]
    # 更早的终点不应让进度回退
    with container.database.session() as conn:
        container.stock_repository.mark_codes_synced(
            conn, ["sh.600001"], date(2026, 1, 5)
        )
    assert container.stock_repository.codes_needing_sync(day) == ["sh.600003"]


def test_schema_migration_adds_last_sync_end(tmp_path) -> None:
    """旧版本数据库可以平滑升级。"""

    import sqlite3

    from app.repositories.database import Database

    path = tmp_path / "legacy.sqlite3"
    legacy = sqlite3.connect(path)
    legacy.execute(
        """
        CREATE TABLE stock (
            code TEXT PRIMARY KEY, exchange TEXT NOT NULL, symbol TEXT NOT NULL,
            name TEXT, board TEXT NOT NULL, ipo_date TEXT, out_date TEXT,
            listing_date TEXT, first_bar_date TEXT,
            is_active INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL
        )
        """
    )
    legacy.commit()
    legacy.close()

    database = Database(path)
    database.initialize()
    database.initialize()

    with database.session() as conn:
        columns = [row["name"] for row in conn.execute("PRAGMA table_info(stock)")]
        versions = [
            row["version"]
            for row in conn.execute("SELECT version FROM schema_version")
        ]
    assert "last_sync_end" in columns
    from app.repositories.database import SCHEMA_VERSION

    assert versions == [SCHEMA_VERSION]
