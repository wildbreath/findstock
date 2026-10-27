"""单日收录的范围、分行、人工保护与原子保存, 全部使用离线存档。"""

from datetime import date, datetime, timedelta
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient

from app.domain.ladder import LadderSnapshot, LimitUpStock
from app.domain.models import DailyBar
from app.main import create_app
from app.repositories.ladder_repository import LadderRepository
from app.services.ladder_service import MARKET_TIMEZONE


def stock(code="sh.600001", consecutive=2, **fields):
    return LimitUpStock(**{
        "code": code, "name": code, "consecutive": consecutive, "price": 11, "pct_chg": 10,
        "amount": None, "turnover": None, "seal_funds": None, "first_seal": "09:30:00",
        "last_seal": None, "breaks": None, "industry": "不应用行业代替题材", "board": "main_sh",
        "board_label": "沪市主板", "is_st": False, **fields,
    })


@pytest.fixture()
def setup(container):
    days = [date(2026, 9, 1) + timedelta(days=i) for i in range(53)]
    opened = [day for day in days if day.weekday() < 5]
    with container.database.session() as conn:
        container.calendar_repository.upsert_days(conn, [(day, day in opened) for day in days])

    def seed(day, items=(), themes=None, final=True):
        items = list(items) or [stock("sh.600999", 1)]
        LadderRepository(container.database).save(LadderSnapshot(
            day, opened, datetime(2026, 10, 24, 18, tzinfo=MARKET_TIMEZONE), items, is_final=final,
        ))
        with container.database.session() as conn:
            batch = conn.execute(
                "INSERT INTO wudao_theme_batch(start_date,end_date,status,is_final,updated_at) VALUES (?,?,'complete',1,?)",
                (day.isoformat(), day.isoformat(), "2026-10-24T18:00:00+08:00"),
            ).lastrowid
            conn.executemany("INSERT INTO wudao_theme_row VALUES (?,?,?,?,?,?)", [
                (batch, day.isoformat(), item.code, (themes or {}).get(item.code, "农业"), "{}", "2026-10-24T18:00:00+08:00")
                for item in items
            ])
    for day in opened:
        seed(day)
    client = TestClient(create_app(), client=("127.0.0.1", 50000))

    def collect(day, *, expected=200):
        revision = client.get("/api/review-sheet").json()["revision"]
        response = client.post("/api/review-sheet/collect", json={"trade_date": str(day), "revision": revision})
        assert response.status_code == expected, response.text
        return response.json()

    return client, seed, collect, opened


def test_scope_staircase_theme_sort_and_idempotence(setup):
    client, seed, collect, days = setup
    day = days[-1]
    seed(day, [stock("sh.600002", 2), stock("sh.600001", 4), stock("sz.000001", 5, board="main_sz"),
               stock("sh.600003", 1), stock("sh.688001", 4, board="star"), stock("sz.300001", 3, board="gem"),
               stock("sh.600004", 3, is_st=True), stock("sh.600005", 3, name="*ST测试")],
         {"sh.600002": "农业", "sh.600001": "农业", "sz.000001": "金融"})
    result = collect(day)
    assert result["added"] == result["updated"] == 3
    sheet = result["sheet"]
    assert [row["tracking"]["code"] for row in sheet["rows"]] == ["sh.600001", "sh.600002", "sz.000001"]
    row = sheet["rows"][0]
    assert row["cells"][str(days[-3])]["text"] == "农业"
    assert row["cells"][str(days[-2])]["kind"] == "stock"
    assert row["cells"][str(day)]["text"] == "4板 +10.00%"
    assert [row["cells"][str(day)]["text"] for row in sheet["rows"]] == [
        "4板 +10.00%", "2板 +10.00%", "5板 +10.00%",
    ]
    assert row["cells"][str(day)]["background"] == "#dc2626"
    repeated = collect(day)
    assert repeated["added"] == 0
    assert repeated["sheet"]["rows"] == sheet["rows"]
    stale = client.post("/api/review-sheet/collect", json={"trade_date": str(day), "revision": 0})
    assert stale.status_code == 409
    seed(day, [stock("sh.600006", 6), stock("sh.600001", 4), stock("sh.600002", 2)])
    corrected = collect(day)
    assert corrected["added"] == 1
    assert [row["tracking"]["code"] for row in corrected["sheet"]["rows"]][:3] == ["sh.600006", "sh.600001", "sh.600002"]


def test_follow_after_break_colors_missing_and_manual_protection(setup, container):
    client, seed, collect, days = setup
    first, second, third = days[-3:]
    seed(first, [stock()])
    sheet = collect(first)["sheet"]
    row = sheet["rows"][0]
    row["leader"] = True
    row["cells"][str(first)].update(text="2板 +10.00%缩量", highlight=True)
    assert client.put("/api/review-sheet", json=sheet).status_code == 200
    seed(first, [stock(consecutive=3, pct_chg=9.98)])
    protected = collect(first)
    marked = protected["sheet"]["rows"][0]
    assert marked["cells"][str(first)]["text"] == "3板 +9.98%缩量"
    assert marked["cells"][str(first)]["highlight"] and marked["leader"]
    with container.database.session() as conn:
        container.bar_repository.upsert_bars(conn, [DailyBar("sh.600001", second, pct_chg=Decimal("-3.25"))])
    result = collect(second)
    assert result["added"] == 0
    assert result["sheet"]["rows"][0]["cells"][str(second)]["text"] == "-3.25%"
    assert result["sheet"]["rows"][0]["cells"][str(second)]["background"] == "#b8d8c4"
    sheet = result["sheet"]
    sheet["rows"][0]["cells"][str(second)].update(text="炸板+5", color="#fff176")
    assert client.put("/api/review-sheet", json=sheet).status_code == 200
    refreshed = collect(second)["sheet"]["rows"][0]
    assert refreshed["cells"][str(second)]["text"] == "炸板+5"
    assert refreshed["cells"][str(second)]["color"] == "#fff176"
    missing = collect(third)
    assert missing["missing_codes"] == ["sh.600001"]
    assert str(third) not in missing["sheet"]["rows"][0]["cells"]
    with container.database.session() as conn:
        container.bar_repository.upsert_bars(conn, [DailyBar("sh.600001", third, pct_chg=Decimal("0"))])
    flat = collect(third)["sheet"]["rows"][0]["cells"][str(third)]
    assert flat["text"] == "0%" and flat["background"] == ""


@pytest.mark.parametrize("gap,expected_rows", [(9, 1), (10, 2), (11, 2)])
def test_new_round_counts_non_limit_trading_days_not_recording_days(setup, gap, expected_rows):
    _, seed, collect, days = setup
    first = days[3]
    seed(first, [stock()])
    original = collect(first)["sheet"]["rows"][0]
    next_first = days[4 + gap]
    next_second = days[5 + gap]
    seed(next_first, [stock(consecutive=1)])
    seed(next_second, [stock(consecutive=2)])
    result = collect(next_second)
    assert len(result["sheet"]["rows"]) == expected_rows
    assert result["sheet"]["rows"][0]["id"] == original["id"]
    if expected_rows == 2:
        assert str(next_second) not in result["sheet"]["rows"][0]["cells"]
        assert result["sheet"]["rows"][1]["tracking"]["entry_date"] == str(next_second)
    # 更新历史日期仍写原行, 不改变后续记录或当前排序。
    again = collect(first)
    assert len(again["sheet"]["rows"]) == expected_rows


def test_intervening_single_limit_resets_gap_and_missing_history_aborts(setup, container):
    client, seed, collect, days = setup
    seed(days[3], [stock()])
    collect(days[3])
    seed(days[10], [stock(consecutive=1)])
    seed(days[20], [stock(consecutive=1)])
    seed(days[21], [stock(consecutive=2)])
    assert collect(days[21])["added"] == 0
    original = client.get("/api/review-sheet").json()
    with container.database.session() as conn:
        conn.execute("DELETE FROM ladder_snapshot WHERE trade_date=?", (str(days[19]),))
    collect(days[21], expected=409)
    assert client.get("/api/review-sheet").json() == original


def test_stop_restore_chronology_and_unclassified(setup):
    client, seed, collect, days = setup
    seed(days[-3], [stock()], {"sh.600001": None})
    first = collect(days[-3])
    assert first["unclassified"] == 1
    sheet = first["sheet"]
    sheet["rows"][0]["tracking"]["stopped"] = True
    assert client.put("/api/review-sheet", json=sheet).status_code == 200
    seed(days[-2], [stock(consecutive=3)])
    stopped = collect(days[-2])
    assert stopped["added"] == stopped["updated"] == 0
    sheet = stopped["sheet"]
    sheet["rows"][0]["tracking"]["stopped"] = False
    assert client.put("/api/review-sheet", json=sheet).status_code == 200
    assert collect(days[-2])["updated"] == 1
    collect(days[-4], expected=422)


def test_incomplete_sources_and_invalid_dates_never_write(setup, container):
    client, seed, collect, days = setup
    original = client.get("/api/review-sheet").json()
    seed(days[-1], [stock()], final=False)
    collect(days[-1], expected=409)
    seed(days[-1], [stock()])
    with container.database.session() as conn:
        conn.execute("UPDATE wudao_theme_batch SET status='pending'")
    collect(days[-1], expected=409)
    collect(date(2026, 10, 18), expected=422)
    collect(date(2099, 1, 1), expected=422)
    assert client.get("/api/review-sheet").json() == original


def test_later_entries_group_by_theme_without_resorting_history(setup):
    _, seed, collect, days = setup
    first, second = days[-2:]
    seed(first, [stock("sh.600001", 2), stock("sh.600002", 4)],
         {"sh.600001": "农业", "sh.600002": "金融"})
    original = collect(first)["sheet"]["rows"]
    seed(second, [stock("sh.600001", 3), stock("sh.600002", 5), stock("sh.600003", 8)],
         {"sh.600001": "农业", "sh.600002": "金融", "sh.600003": "农业"})
    rows = collect(second)["sheet"]["rows"]
    assert [row["tracking"]["code"] for row in rows] == ["sh.600001", "sh.600003", "sh.600002"]
    assert rows[0]["id"] == original[0]["id"] and rows[2]["id"] == original[1]["id"]
    assert rows[1]["cells"][str(first)]["kind"] == "stock"
    assert rows[1]["cells"][str(days[-3])]["kind"] == "theme"


def test_manual_theme_overrides_source_for_new_round_and_future_grouping(setup):
    client, seed, collect, days = setup
    first, last = days[4], days[19]
    seed(first, [stock()])
    sheet = collect(first)["sheet"]
    row = sheet["rows"][0]
    row["theme"] = "人工科技"
    # Even a legacy label left behind must not add this row to its previous theme.
    original_cells = row["cells"].copy()
    assert client.put("/api/review-sheet", json=sheet).status_code == 200
    seed(last, [stock(), stock("sh.600002")], {"sh.600001": "源端分类", "sh.600002": "人工科技"})
    result = collect(last)
    rows = result["sheet"]["rows"]
    assert len(rows) == 3
    assert [value["tracking"]["theme"] for value in rows[1:]] == ["人工科技", "人工科技"]
    assert rows[1]["theme"] == "人工科技"
    assert rows[0]["cells"][str(days[2])] == original_cells[str(days[2])]
    assert collect(last)["sheet"]["rows"] == rows


def test_calendar_hole_aborts_without_guessing_holidays(setup, container):
    client, seed, collect, days = setup
    seed(days[3], [stock()])
    collect(days[3])
    before = client.get("/api/review-sheet").json()
    with container.database.session() as conn:
        conn.execute("DELETE FROM trading_day WHERE trade_date=?", (str(days[4]),))
    collect(days[-1], expected=409)
    assert client.get("/api/review-sheet").json() == before


@pytest.mark.parametrize("gap,new_rows", [(1, 0), (10, 1)])
def test_stopped_stock_resumes_only_after_a_new_second_board(setup, gap, new_rows):
    client, seed, collect, days = setup
    first = days[3]
    seed(first, [stock()])
    sheet = collect(first)["sheet"]
    sheet["rows"][0]["tracking"].update(stopped=True, stopped_after=str(first))
    assert client.put("/api/review-sheet", json=sheet).status_code == 200
    assert collect(first)["updated"] == 0, "Repeating the stopped second board must not resume it"
    seed(days[4], [stock(consecutive=3)])
    assert collect(days[4])["updated"] == 0, "A higher board in the same run must stay stopped"
    next_first, next_second = days[5 + gap], days[6 + gap]
    seed(next_first, [stock(consecutive=1)])
    assert collect(next_first)["updated"] == 0
    seed(next_second, [stock()])
    result = collect(next_second)
    # days[4] 是上轮最后一次涨停, 到 next_first 之间有 gap 个未涨停交易日。
    assert result["resumed"] == 1 and result["updated"] == 1
    assert result["added"] == new_rows
    assert all(not row["tracking"]["stopped"] for row in result["sheet"]["rows"])


def test_new_stock_joins_legacy_manual_theme_without_changing_manual_cells(setup):
    client, seed, collect, days = setup
    old = {"id": "manual", "cells": {str(days[-3]): {"text": "农业", "background": "#7e22a8"}}}
    payload = {"revision": 0, "dates": [str(day) for day in days[-3:]], "rows": [old]}
    manual = client.put("/api/review-sheet", json=payload).json()["rows"][0]
    seed(days[-1], [stock("sh.600001"), stock("sh.600002"), stock("sh.600003")],
         {"sh.600001": "农业", "sh.600002": "金融", "sh.600003": "金融"})
    rows = collect(days[-1])["sheet"]["rows"]
    assert rows[0] == manual
    assert rows[1]["tracking"]["theme"] == "农业"
    assert [row["tracking"]["theme"] for row in rows[2:]] == ["金融", "金融"]


def test_limit_cells_use_daily_close_pct_and_missing_is_not_ten_percent(setup, container):
    client, seed, collect, days = setup
    day = days[-1]
    seed(day, [stock(pct_chg=10), stock("sh.600002", pct_chg=None)])
    with container.database.session() as conn:
        container.bar_repository.upsert_bars(conn, [DailyBar("sh.600001", day, pct_chg=Decimal("9.97"))])
    result = collect(day)
    rows = result["sheet"]["rows"]
    assert rows[0]["cells"][str(day)]["text"] == "2板 +9.97%", "Keep the actual daily change alongside the board height"
    assert result["missing_codes"] == ["sh.600002"]
    assert str(day) not in rows[1]["cells"]
    # 已有旧版连板文字在重复收录时迁移, 保留人工追加的描述。
    rows[0]["cells"][str(day)].update(text="2板缩量", auto_text="2板")
    assert client.put("/api/review-sheet", json=result["sheet"]).status_code == 200
    assert collect(day)["sheet"]["rows"][0]["cells"][str(day)]["text"] == "2板 +9.97%缩量"
    legacy = collect(day)["sheet"]
    legacy["rows"][0]["cells"][str(day)].update(text="+9.97%放量", auto_text="+9.97%")
    assert client.put("/api/review-sheet", json=legacy).status_code == 200
    assert collect(day)["sheet"]["rows"][0]["cells"][str(day)]["text"] == "2板 +9.97%放量"


@pytest.mark.parametrize("pct,close,preclose,background", [
    ("3.25", None, None, "#efb7b2"),
    ("9.99", "10.99", "10", "#efb7b2"),
    ("-3.25", None, None, "#b8d8c4"),
    ("-9.97", "3.43", "3.81", "#237b3b"),
    ("-9.95", "9.05", "10.05", "#237b3b"),
    ("-9.99", "9.01", "10", "#b8d8c4"),
    ("-10", None, None, "#237b3b"),
    ("0", None, None, ""),
])
def test_follow_colors_distinguish_limits_from_ordinary_moves(setup, container, pct, close, preclose, background):
    _, seed, collect, days = setup
    first, second = days[-2:]
    seed(first, [stock()])
    collect(first)
    with container.database.session() as conn:
        container.bar_repository.upsert_bars(conn, [DailyBar(
            "sh.600001", second, pct_chg=Decimal(pct),
            close=Decimal(close) if close else None, preclose=Decimal(preclose) if preclose else None,
        )])
    cell = collect(second)["sheet"]["rows"][0]["cells"][str(second)]
    assert cell["background"] == background
    assert cell["text"] == (f"{Decimal(pct):+.2f}%" if Decimal(pct) else "0%")


def test_first_limit_after_break_uses_deep_red_without_a_consecutive_label(setup):
    _, seed, collect, days = setup
    first, second = days[-2:]
    seed(first, [stock()])
    collect(first)
    seed(second, [stock(consecutive=1, pct_chg=9.97)])
    cell = collect(second)["sheet"]["rows"][0]["cells"][str(second)]
    assert cell["text"] == "+9.97%"
    assert cell["background"] == "#dc2626"


def test_manual_preparation_fills_local_history_without_saving_or_changing_other_rows(setup, container):
    client, seed, _, days = setup
    first, second, last = days[-3:]
    seed(first, [stock(consecutive=2)])
    seed(second, [stock(consecutive=3)])
    with container.database.session() as conn:
        container.bar_repository.upsert_bars(conn, [
            DailyBar("sh.600001", first, pct_chg=Decimal("9.97")),
            DailyBar("sh.600001", last, pct_chg=Decimal("-3.25")),
            DailyBar("sh.600002", last, pct_chg=Decimal("5")),
        ])
    before = client.get("/api/review-sheet").json()
    response = client.post("/api/review-sheet/stock-rows", json={
        "stocks": [{"code": "sh.600001", "name": "手工甲"}], "theme": "人工题材", "trade_date": str(first),
    })
    assert response.status_code == 200, response.text
    result = response.json()
    row = result["rows"][0]
    assert row["cells"][str(days[-5])]["text"] == "人工题材"
    assert row["cells"][str(days[-4])]["text"] == "手工甲"
    assert row["cells"][str(first)]["text"] == "2板 +9.97%"
    assert row["cells"][str(second)]["text"] == "3板 +10.00%"
    assert row["cells"][str(last)]["text"] == "-3.25%"
    assert row["cells"][str(last)]["background"] == "#b8d8c4"
    assert row["tracking"]["entry_date"] == str(first)
    assert result["missing_cells"] == 0
    assert result["unconfirmed_dates"] == []
    assert result["dates"][-1] == str(last)
    assert client.get("/api/review-sheet").json() == before


def test_manual_themes_and_whole_row_copies_continue_updating_independently(setup):
    from copy import deepcopy

    client, seed, collect, days = setup
    first, second = days[-2:]
    seed(first, [stock()])
    sheet = collect(first)["sheet"]
    original = deepcopy(sheet["rows"][0])
    result = client.post("/api/review-sheet/stock-rows", json={
        "stocks": [{"code": "sh.600001", "name": "手工甲"}], "theme": "金融", "trade_date": str(first),
    }).json()
    manual = result["rows"][0]
    manual["cells"][str(first)].update(text="2板 +10.00%金融备注", highlight=True)
    copied = deepcopy(original)
    copied.update(id="copied", stock_code="sh.600001", theme="科技")
    copied["tracking"]["theme"] = "科技"
    sheet["rows"] += [manual, copied]
    sheet["dates"] = sorted(set(sheet["dates"]) | set(result["dates"]))
    assert client.put("/api/review-sheet", json=sheet).status_code == 200
    seed(second, [stock(consecutive=3)])
    result = collect(second)
    assert result["added"] == 0 and result["updated"] == 3
    rows = result["sheet"]["rows"]
    assert len(rows) == 3
    assert all(row["cells"][str(second)]["text"] == "3板 +10.00%" for row in rows)
    assert rows[0]["tracking"]["theme"] == "农业"
    assert next(row for row in rows if row["id"] == manual["id"])["cells"][str(first)]["text"] == "2板 +10.00%金融备注"
    assert rows[0]["cells"][str(first)] == original["cells"][str(first)]


@pytest.mark.parametrize("code,name,pct,close,background", [
    ("sz.300001", "创业甲", "-20", "8", "#237b3b"),
    ("sh.688001", "科创甲", "-10", "9", "#b8d8c4"),
    ("sh.600009", "*ST甲", "-5", "9.5", "#237b3b"),
])
def test_manual_tracking_accepts_other_boards_and_uses_their_price_limits(setup, container, code, name, pct, close, background):
    client, _, collect, days = setup
    first, last = days[-2:]
    with container.database.session() as conn:
        container.bar_repository.upsert_bars(conn, [DailyBar(
            code, day, pct_chg=Decimal(pct), close=Decimal(close), preclose=Decimal("10"),
        ) for day in (first, last)])
    response = client.post("/api/review-sheet/stock-rows", json={
        "stocks": [{"code": code, "name": name}], "theme": "手工", "trade_date": str(first),
    })
    assert response.status_code == 200, response.text
    result = response.json()
    row = result["rows"][0]
    assert row["cells"][str(first)]["background"] == background
    saved = client.put("/api/review-sheet", json={"revision": 0, "dates": result["dates"], "rows": [row]})
    assert saved.status_code == 200, saved.text
    filled = collect(last)
    assert filled["added"] == 0 and filled["updated"] == 1
    assert filled["sheet"]["rows"][0]["cells"][str(last)]["background"] == background


def test_manual_missing_data_is_left_blank_and_invalid_calendar_never_changes_sheet(setup, container):
    client, _, _, days = setup
    request = {"stocks": [{"code": "sh.600001", "name": "缺行情"}], "theme": "手工", "trade_date": str(days[-2])}
    before = client.get("/api/review-sheet").json()
    response = client.post("/api/review-sheet/stock-rows", json=request)
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["missing_cells"] == 2
    assert str(days[-2]) not in result["rows"][0]["cells"]
    assert str(days[-1]) not in result["rows"][0]["cells"]
    with container.database.session() as conn:
        conn.execute("DELETE FROM ladder_snapshot WHERE trade_date=?", (str(days[-2]),))
    incomplete = client.post("/api/review-sheet/stock-rows", json=request).json()
    assert incomplete["unconfirmed_dates"] == [str(days[-2])]
    with container.database.session() as conn:
        conn.execute("DELETE FROM trading_day WHERE trade_date=?", (str(days[-1]),))
    assert client.post("/api/review-sheet/stock-rows", json=request).status_code == 409
    assert client.get("/api/review-sheet").json() == before


def test_missing_stock_in_multiple_manual_themes_is_reported_once(setup):
    client, _, collect, days = setup
    rows, dates = [], []
    for theme in ("农业", "金融"):
        prepared = client.post("/api/review-sheet/stock-rows", json={
            "stocks": [{"code": "sh.600001", "name": "甲股"}], "theme": theme, "trade_date": str(days[-2]),
        }).json()
        rows.extend(prepared["rows"])
        dates = prepared["dates"]
    assert client.put("/api/review-sheet", json={"revision": 0, "rows": rows, "dates": dates}).status_code == 200
    result = collect(days[-1])
    assert result["missing_codes"] == ["sh.600001"]


def test_legacy_manual_secondary_theme_does_not_reclassify_a_new_automatic_round(setup):
    client, seed, collect, days = setup
    first, last = days[4], days[20]
    seed(first, [stock()])
    sheet = collect(first)["sheet"]
    secondary = {"id": "legacy-secondary", "stock_code": "sh.600001", "theme": "手工第二题材",
                 "cells": {str(first): {"text": "甲股", "kind": "stock"}}}
    sheet["rows"].append(secondary)
    saved = client.put("/api/review-sheet", json=sheet).json()
    original_secondary = next(row for row in saved["rows"] if row["id"] == secondary["id"])
    seed(last, [stock()])
    result = collect(last)
    new = next(row for row in result["sheet"]["rows"] if row.get("tracking") and row["tracking"]["entry_date"] == str(last))
    assert new["tracking"]["theme"] == "农业"
    assert next(row for row in result["sheet"]["rows"] if row["id"] == secondary["id"]) == original_secondary


def test_market_prefix_updates_preserve_notes_starting_with_a_number():
    from app.services.review_collection_service import update_market_cell

    cell = {"text": "+3.00%2次炸板", "auto_text": "+3.00%", "highlight": True}
    update_market_cell(cell, Decimal("4"), None, None, "sh.600001", "甲股")
    assert cell["text"] == "+4.00%2次炸板"
    assert cell["highlight"]


def test_invalid_price_fields_do_not_break_valid_daily_change_display():
    from app.services.review_collection_service import update_market_cell

    bar = DailyBar("sh.600001", date(2026, 10, 23), close=Decimal("8"), preclose=Decimal("Infinity"))
    cell = {}
    update_market_cell(cell, Decimal("-3"), None, bar, "sh.600001", "甲股")
    assert cell["text"] == "-3.00%"
    assert cell["background"] == "#b8d8c4"
