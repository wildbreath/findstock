"""全市场搜索、自选备注高亮和手动排序的回归测试。"""

from __future__ import annotations

import sqlite3
from datetime import date
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.container import Container
from app.main import create_app
from app.repositories.database import SCHEMA_VERSION, Database
from app.repositories.watchlist_repository import WatchlistItem, WatchlistRepository
from tests.factories import make_stock


@pytest.fixture()
def client(container: Container) -> TestClient:
    with container.database.session() as conn:
        container.stock_repository.upsert_stocks(conn, [
            make_stock("sh.600000", "浦发银行"),
            make_stock("sh.600519", "贵州茅台"),
            make_stock("sz.000001", "平安银行"),
            make_stock("sz.300750", "宁德时代"),
        ])
    return TestClient(create_app())


def test_market_search_includes_stocks_outside_watchlist(client: TestClient) -> None:
    client.post("/api/watchlist", json={"code": "sh.600519"})
    results = client.get("/api/stocks/search", params={"q": "银行"}).json()
    assert results == [
        {"code": "sh.600000", "name": "浦发银行", "board": "main_sh", "board_label": "沪市主板"},
        {"code": "sz.000001", "name": "平安银行", "board": "main_sz", "board_label": "深市主板"},
    ]
    found = client.get("/api/stocks/search", params={"q": "300750"}).json()
    assert found[0]["name"] == "宁德时代"
    assert client.post("/api/watchlist", json={"code": found[0]["code"]}).status_code == 201


def test_market_search_trims_codes_and_limits_results(client: TestClient) -> None:
    exact = client.get("/api/stocks/search", params={"q": " SH.600519 "}).json()
    assert [item["code"] for item in exact] == ["sh.600519"]
    limited = client.get("/api/stocks/search", params={"q": "银行", "limit": 1}).json()
    assert len(limited) == 1
    assert client.get("/api/stocks/search", params={"q": "  "}).json() == []
    assert client.get("/api/stocks/search", params={"q": "%"}).json() == []
    assert client.get("/api/stocks/search", params={"q": "不存在"}).json() == []
    assert client.get("/api/stocks/search?limit=0").status_code == 422
    assert client.get("/api/stocks/search?limit=51").status_code == 422


def test_note_highlights_persist_and_survive_unrelated_changes(client: TestClient) -> None:
    created = client.post("/api/watchlist", json={"code": "sh.600519"}).json()
    assert created["note_highlights"] == []
    note = "回踩😀后观察放量"
    updated = client.patch("/api/watchlist/sh.600519", json={
        "note": note, "note_highlights": [[5, 8], [0, 2]],
    })
    assert updated.status_code == 200
    assert updated.json()["note_highlights"] == [[0, 2], [5, 8]]
    assert client.get("/api/watchlist").json()["items"][0]["note_highlights"] == [[0, 2], [5, 8]]
    category = client.post("/api/watchlist/categories", json={"name": "重点观察"}).json()
    changed = client.patch("/api/watchlist/sh.600519", json={"category_ids": [category["id"]]})
    assert changed.json()["note_highlights"] == [[0, 2], [5, 8]]
    duplicate = client.post("/api/watchlist", json={"code": "sh.600519", "note": "其他来源备注"})
    assert duplicate.json()["note"] == note
    assert duplicate.json()["note_highlights"] == [[0, 2], [5, 8]]
    assert duplicate.json()["categories"] == [{"id": category["id"], "name": "重点观察"}]


def test_highlight_only_update_normalizes_overlaps_and_clear(client: TestClient) -> None:
    client.post("/api/watchlist", json={"code": "sh.600000", "note": "观察突破后回踩"})
    updated = client.patch("/api/watchlist/sh.600000", json={
        "note_highlights": [[4, 6], [0, 3], [2, 4]],
    })
    assert updated.json()["note"] == "观察突破后回踩"
    assert updated.json()["note_highlights"] == [[0, 6]]
    cleared = client.patch("/api/watchlist/sh.600000", json={"note_highlights": []})
    assert cleared.json()["note"] == "观察突破后回踩"
    assert cleared.json()["note_highlights"] == []
    client.patch("/api/watchlist/sh.600000", json={"note_highlights": [[0, 2]]})
    edited = client.patch("/api/watchlist/sh.600000", json={"note": " 新思路 "})
    assert edited.json()["note"] == "新思路"
    assert edited.json()["note_highlights"] == []
    client.patch("/api/watchlist/sh.600000", json={"note_highlights": [[0, 2]]})
    empty = client.patch("/api/watchlist/sh.600000", json={"note": None})
    assert empty.json()["note"] is None
    assert empty.json()["note_highlights"] == []


@pytest.mark.parametrize("ranges", [
    [[-1, 2]], [[1, 1]], [[2, 1]], [[0, 20]], [[True, 2]],
    [[0, 1.5]], [[0, "2"]], [[0]], [[0, 1, 2]], "invalid", None,
])
def test_invalid_highlights_do_not_change_observation_or_category(
    client: TestClient, ranges: object,
) -> None:
    client.post("/api/watchlist", json={"code": "sh.600000", "note": "原备注"})
    category = client.post("/api/watchlist/categories", json={"name": "观察"}).json()
    response = client.patch("/api/watchlist/sh.600000", json={
        "note": "新备注", "note_highlights": ranges, "category_ids": [category["id"]],
    })
    assert response.status_code == 422
    item = client.get("/api/watchlist").json()["items"][0]
    assert item["note"] == "原备注"
    assert item["note_highlights"] == []
    assert item["categories"] == []


def test_manual_order_persists_and_new_additions_are_first(
    client: TestClient, container: Container,
) -> None:
    codes = ["sh.600000", "sh.600519", "sz.000001"]
    for code in codes:
        client.post("/api/watchlist", json={"code": code})
    assert client.get("/api/watchlist").json()["codes"] == codes[::-1]
    ordered = [codes[1], codes[0], codes[2]]
    saved = client.put("/api/watchlist/order", json={"codes": ordered})
    assert saved.status_code == 200
    assert saved.json() == {"codes": ordered}
    assert client.get("/api/watchlist").json()["codes"] == ordered
    container.database.initialize()
    assert [item.code for item in WatchlistRepository(container.database).list_all()] == ordered
    client.post("/api/watchlist", json={"code": codes[0]})
    assert client.get("/api/watchlist").json()["codes"] == ordered
    client.post("/api/watchlist", json={"code": "sz.300750"})
    assert client.get("/api/watchlist").json()["codes"] == ["sz.300750", *ordered]
    client.delete("/api/watchlist/sh.600000")
    assert client.get("/api/watchlist").json()["codes"] == ["sz.300750", codes[1], codes[2]]


@pytest.mark.parametrize("codes", [
    [], ["sh.600000"], ["sh.600000", "sh.600000"],
    ["sh.600000", "sz.000001"], ["bad-code", "sh.600519"],
])
def test_invalid_or_stale_order_is_atomic(client: TestClient, codes: list[str]) -> None:
    for code in ["sh.600000", "sh.600519"]:
        client.post("/api/watchlist", json={"code": code})
    response = client.put("/api/watchlist/order", json={"codes": codes})
    assert response.status_code == 422
    assert client.get("/api/watchlist").json()["codes"] == ["sh.600519", "sh.600000"]


def test_empty_watchlist_order(client: TestClient) -> None:
    response = client.put("/api/watchlist/order", json={"codes": []})
    assert response.status_code == 200
    assert response.json() == {"codes": []}


def test_batch_add_appends_categories_and_preserves_existing_observations(client: TestClient) -> None:
    old = client.post("/api/watchlist/categories", json={"name": "原分类"}).json()["id"]
    category = client.post("/api/watchlist/categories", json={"name": "10月23日机器人"}).json()["id"]
    original = client.post("/api/watchlist", json={
        "code": "sh.600000", "note": "原观察思路", "category_ids": [old],
    }).json()
    client.patch("/api/watchlist/sh.600000", json={"note_highlights": [[0, 2]]})
    client.post("/api/watchlist", json={"code": "sh.600519", "category_ids": [old]})
    response = client.post("/api/watchlist/batch", json={
        "items": [{"code": "sz.000001"}, {"code": "sh.600000"},
                  {"code": "sz.001234", "name": "题材存档名称"}],
        "source_date": "2026-10-23", "category_ids": [category, category],
    })
    assert response.status_code == 200
    data = response.json()
    assert data["codes"] == ["sz.000001", "sz.001234", "sh.600519", "sh.600000"]
    items = {item["code"]: item for item in data["items"]}
    assert items["sh.600000"]["note"] == "原观察思路"
    assert items["sh.600000"]["note_highlights"] == [[0, 2]]
    assert items["sh.600000"]["added_at"] == original["added_at"]
    assert {item["id"] for item in items["sh.600000"]["categories"]} == {old, category}
    assert items["sh.600519"]["categories"] == [{"id": old, "name": "原分类"}]
    assert items["sz.001234"]["name"] == "题材存档名称"
    assert items["sz.001234"]["source_date"] == "2026-10-23"
    repeated = client.post("/api/watchlist/batch", json={
        "items": [{"code": "sh.600000"}], "source_date": "2026-10-23",
        "category_ids": [category], "replace_categories": True,
    }).json()
    assert repeated["codes"] == data["codes"]
    changed = next(item for item in repeated["items"] if item["code"] == "sh.600000")
    assert changed["categories"] == [{"id": category, "name": "10月23日机器人"}]
    assert changed["note_highlights"] == [[0, 2]]


@pytest.mark.parametrize("replace", [False, True])
def test_batch_without_categories_keeps_or_clears_only_selected_stock(
    client: TestClient, replace: bool,
) -> None:
    category = client.post("/api/watchlist/categories", json={"name": "原分类"}).json()["id"]
    for code in ["sh.600000", "sh.600519"]:
        client.post("/api/watchlist", json={"code": code, "category_ids": [category]})
    response = client.post("/api/watchlist/batch", json={
        "items": [{"code": "sh.600000"}, {"code": "sz.000001"}],
        "source_date": "2026-10-23", "replace_categories": replace,
    })
    assert response.status_code == 200
    items = {item["code"]: item for item in response.json()["items"]}
    assert bool(items["sh.600000"]["categories"]) is not replace
    assert items["sh.600519"]["categories"] == [{"id": category, "name": "原分类"}]
    assert items["sz.000001"]["categories"] == []


@pytest.mark.parametrize("override", [
    {"items": []}, {"items": [{"code": "invalid"}]},
    {"items": [{"code": "sh.600000"}, {"code": "sh.600000"}]},
    {"source_date": "invalid"}, {"category_ids": [999]},
    {"category_ids": [True]}, {"category_ids": ["1"]},
])
def test_invalid_batch_does_not_change_watchlist(client: TestClient, override: dict) -> None:
    client.post("/api/watchlist", json={"code": "sh.600519", "note": "原备注"})
    before = client.get("/api/watchlist").json()
    payload = {"items": [{"code": "sh.600000"}], "source_date": "2026-10-23", **override}
    assert client.post("/api/watchlist/batch", json=payload).status_code == 422
    assert client.get("/api/watchlist").json() == before


def test_batch_rolls_back_after_a_later_write_fails(container: Container, monkeypatch) -> None:
    repository = container.watchlist_repository
    category = repository.create_category("原分类")
    repository.add(WatchlistItem(code="sh.600000", name="原名称", note="原备注"),
                   category_ids=[category.id])
    before = repository.list_all()
    original_add = repository._add

    def fail_after_write(conn, item):
        original_add(conn, item)
        if item.code == "sz.000001":
            raise sqlite3.OperationalError("模拟写入中断")

    monkeypatch.setattr(repository, "_add", fail_after_write)
    with pytest.raises(sqlite3.OperationalError, match="模拟写入中断"):
        repository.add_many([
            WatchlistItem(code="sz.000001"),
            WatchlistItem(code="sh.600000", name="被修改的名称", source_date=date(2026, 10, 23)),
        ], category_ids=[], replace_categories=True)
    assert repository.list_all() == before
    assert repository.category_ids_for("sh.600000") == [category.id]


def test_watchlist_v5_migration_preserves_order_notes_and_memberships(tmp_path: Path) -> None:
    path = tmp_path / "legacy.sqlite3"
    with sqlite3.connect(path) as conn:
        conn.execute(
            "CREATE TABLE watchlist (code TEXT PRIMARY KEY, name TEXT, board TEXT, "
            "source_date TEXT, note TEXT, added_at TEXT NOT NULL)"
        )
        conn.executemany("INSERT INTO watchlist VALUES (?, ?, ?, ?, ?, ?)", [
            ("sh.600519", "贵州茅台", "main_sh", "2026-10-20", "原观察思路", "2026-10-20T10:00:00"),
            ("sz.000001", "平安银行", "main_sz", None, None, "2026-10-21T10:00:00"),
            ("sh.600000", "浦发银行", "main_sh", None, None, "2026-10-21T10:00:00"),
        ])
        conn.executescript(
            "CREATE TABLE watchlist_category (id INTEGER PRIMARY KEY AUTOINCREMENT, "
            "name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);"
            "CREATE TABLE watchlist_member (code TEXT NOT NULL, category_id INTEGER NOT NULL, "
            "added_at TEXT NOT NULL, PRIMARY KEY (code, category_id), "
            "FOREIGN KEY (code) REFERENCES watchlist(code) ON DELETE CASCADE, "
            "FOREIGN KEY (category_id) REFERENCES watchlist_category(id) ON DELETE CASCADE);"
            "INSERT INTO watchlist_category VALUES (7, '旧分类', '2026-10-20T10:00:00');"
            "INSERT INTO watchlist_member VALUES ('sh.600519', 7, '2026-10-20T10:00:00');"
            "CREATE TABLE schema_version (version INTEGER NOT NULL, applied_at TEXT NOT NULL);"
            "INSERT INTO schema_version VALUES (5, '2026-10-20T10:00:00');"
        )
    database = Database(path)
    database.initialize()
    repository = WatchlistRepository(database)
    original_order = ["sh.600000", "sz.000001", "sh.600519"]
    assert [item.code for item in repository.list_all()] == original_order
    assert all(item.note_highlights == () for item in repository.list_all())
    item = repository.get("sh.600519")
    assert item is not None and item.note == "原观察思路"
    assert item.source_date.isoformat() == "2026-10-20"
    assert repository.category_ids_for(item.code) == [7]
    assert repository.list_categories()[0].name == "旧分类"
    assert repository.list_categories()[0].count == 1
    repository.update_note(item.code, item.note, note_highlights=((1, 3),))
    reordered = original_order[::-1]
    repository.reorder(reordered)
    database.initialize()
    assert [entry.code for entry in repository.list_all()] == reordered
    assert repository.get(item.code).note_highlights == ((1, 3),)
    assert repository.category_ids_for(item.code) == [7]
    with database.session() as conn:
        assert conn.execute("SELECT MAX(version) FROM schema_version").fetchone()[0] == SCHEMA_VERSION
