"""K 线与自选股接口测试。"""

from __future__ import annotations

from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient

from app.container import Container
from app.main import create_app
from tests.factories import make_bar, make_stock, seed

D0 = date(2026, 9, 14)
D1 = date(2026, 9, 15)
D2 = date(2026, 9, 16)


@pytest.fixture()
def client(container: Container) -> TestClient:
    return TestClient(create_app())


@pytest.fixture()
def charted(client: TestClient, container: Container) -> Container:
    """写入 40 个交易日的行情, 便于校验均线。"""

    # 最后一个交易日就是 D2, 便于校验 end 过滤
    days = [D2 - timedelta(days=39 - index) for index in range(40)]
    bars = [
        make_bar("sh.600519", day, close=10.0 + index, pct_chg=1.0, volume=1_000_000)
        for index, day in enumerate(days)
    ]
    seed(
        container,
        open_days=days,
        stocks=[make_stock("sh.600519", "测试白酒", listing_date=date(2015, 1, 1))],
        bars=bars,
    )
    return container


def test_chart_returns_bars_with_moving_averages(
    client: TestClient, charted: Container
) -> None:
    response = client.get("/api/stocks/sh.600519/chart?limit=30")
    assert response.status_code == 200
    payload = response.json()
    assert payload["code"] == "sh.600519"
    assert payload["name"] == "测试白酒"
    assert payload["ma_windows"] == [5, 10, 20, 60]
    assert len(payload["bars"]) == 30

    # 最后一根 K 线: 收盘价 10 + 39 = 49
    last = payload["bars"][-1]
    assert last["close"] == 49.0
    assert last["high"] is not None and last["low"] is not None
    # MA5 = (45+46+47+48+49)/5 = 47
    assert last["ma"]["5"] == 47.0
    # MA10 = (40..49) 平均 = 44.5
    assert last["ma"]["10"] == 44.5
    assert last["ma"]["20"] == 39.5
    # 本地只有 40 根, MA60 无法计算
    assert last["ma"]["60"] is None


def test_chart_ma_is_warm_at_window_start(
    client: TestClient, charted: Container
) -> None:
    """返回窗口最左端的均线也要有效 (服务端多取了预热数据)。"""

    payload = client.get("/api/stocks/sh.600519/chart?limit=20").json()
    first = payload["bars"][0]
    assert first["ma"]["20"] is not None
    assert first["ma"]["10"] is not None


def test_chart_respects_end_date(client: TestClient, charted: Container) -> None:
    payload = client.get(
        f"/api/stocks/sh.600519/chart?limit=180&end={D2.isoformat()}"
    ).json()
    assert payload["bars"][-1]["trade_date"] == D2.isoformat()


def test_chart_and_watchlist_do_not_read_the_whole_stock_catalog(
    client: TestClient, charted: Container, monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fail():
        raise AssertionError("单只股票查询不应读取全市场名单")

    monkeypatch.setattr(client.app.state.container.stock_repository, "list_all", fail)
    assert client.get("/api/stocks/sh.600519/chart?limit=20").json()["name"] == "测试白酒"
    assert client.post("/api/watchlist", json={"code": "sh.600519"}).status_code == 201
    assert client.get("/api/watchlist").json()["items"][0]["name"] == "测试白酒"


def test_chart_unknown_code_returns_404(client: TestClient, charted: Container) -> None:
    response = client.get("/api/stocks/sh.600000/chart")
    assert response.status_code == 404
    error = response.json()["error"]
    assert error["code"] == "stock_not_found"


def test_chart_rejects_bad_code(client: TestClient, charted: Container) -> None:
    assert client.get("/api/stocks/600519/chart").status_code == 422
    assert client.get("/api/stocks/bj.430047/chart").status_code == 422


def test_watchlist_add_list_remove(client: TestClient, charted: Container) -> None:
    empty = client.get("/api/watchlist").json()
    assert empty["items"] == []

    created = client.post(
        "/api/watchlist",
        json={"code": "sh.600519", "source_date": D2.isoformat(), "note": "测试收藏"},
    )
    assert created.status_code == 201
    item = created.json()
    assert item["code"] == "sh.600519"
    assert item["name"] == "测试白酒"
    assert item["board_label"] == "沪市主板"
    assert item["latest_pct_chg"] == 1.0
    assert item["latest_date"] == D2.isoformat()

    listing = client.get("/api/watchlist").json()
    assert listing["codes"] == ["sh.600519"]
    assert listing["items"][0]["source_date"] == D2.isoformat()

    removed = client.delete("/api/watchlist/sh.600519")
    assert removed.status_code == 200
    assert removed.json()["removed"] is True
    assert client.get("/api/watchlist").json()["items"] == []


def test_watchlist_add_is_idempotent(client: TestClient, charted: Container) -> None:
    for _ in range(2):
        response = client.post("/api/watchlist", json={"code": "sh.600519"})
        assert response.status_code == 201
    listing = client.get("/api/watchlist").json()
    assert listing["codes"] == ["sh.600519"]


def test_watchlist_rejects_bad_code(client: TestClient, charted: Container) -> None:
    assert client.post("/api/watchlist", json={"code": "600519"}).status_code == 422
    assert client.delete("/api/watchlist/not-a-code").status_code == 422


def test_watchlist_add_with_categories(client: TestClient, charted: Container) -> None:
    first = client.post("/api/watchlist/categories", json={"name": "突破"}).json()["id"]
    second = client.post("/api/watchlist/categories", json={"name": "观察"}).json()["id"]
    added = client.post("/api/watchlist", json={
        "code": "sh.600519", "source_date": D2.isoformat(),
        "category_ids": [first, second, first, 99999],
    })
    assert added.status_code == 201
    assert {c["id"] for c in added.json()["categories"]} == {first, second}
    assert added.json()["source_date"] == D2.isoformat()
    assert all(c["count"] == 1 for c in client.get("/api/watchlist/categories").json())
    # 旧调用不传分类时保留已有归属，显式空列表才清空。
    repeated = client.post("/api/watchlist", json={"code": "sh.600519"}).json()
    assert {c["id"] for c in repeated["categories"]} == {first, second}
    cleared = client.post("/api/watchlist", json={"code": "sh.600519", "category_ids": []})
    assert cleared.json()["categories"] == []
    assert len(client.get("/api/watchlist").json()["items"]) == 1
    assert client.post("/api/watchlist", json={
        "code": "sh.600519", "category_ids": ["invalid"],
    }).status_code == 422


@pytest.mark.parametrize("already_watched", [False, True])
def test_watchlist_add_categories_rolls_back_on_failure(
    client: TestClient, charted: Container, monkeypatch: pytest.MonkeyPatch,
    already_watched: bool,
) -> None:
    if already_watched:
        client.post("/api/watchlist", json={"code": "sh.600519", "note": "原备注"})

    def fail(*args: object) -> None:
        raise RuntimeError("模拟分类写入失败")

    monkeypatch.setattr(client.app.state.container.watchlist_repository, "_set_categories", fail)
    with pytest.raises(RuntimeError, match="模拟分类写入失败"):
        client.post("/api/watchlist", json={
            "code": "sh.600519", "note": "不应保存", "category_ids": [1],
        })
    items = client.get("/api/watchlist").json()["items"]
    if already_watched:
        assert items[0]["note"] == "原备注"
    else:
        assert items == []


def test_watchlist_note_update_and_clear(
    client: TestClient, charted: Container
) -> None:
    client.post("/api/watchlist", json={"code": "sh.600519"})

    updated = client.patch(
        "/api/watchlist/sh.600519", json={"note": "  二次放量后回踩 5 日线  "}
    )
    assert updated.status_code == 200
    assert updated.json()["note"] == "二次放量后回踩 5 日线"

    listed = client.get("/api/watchlist").json()
    assert listed["items"][0]["note"] == "二次放量后回踩 5 日线"

    cleared = client.patch("/api/watchlist/sh.600519", json={"note": "   "})
    assert cleared.json()["note"] is None


def test_watchlist_patch_unknown_code_returns_404(
    client: TestClient, charted: Container
) -> None:
    response = client.patch("/api/watchlist/sh.600000", json={"note": "x"})
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "stock_not_found"


def test_watchlist_categories_crud_and_membership(
    client: TestClient, charted: Container
) -> None:
    """自建分类 + 一只股票归入多个分类。"""

    growth = client.post("/api/watchlist/categories", json={"name": "成长股"})
    assert growth.status_code == 201
    value = client.post("/api/watchlist/categories", json={"name": "低估值"})
    growth_id = growth.json()["id"]
    value_id = value.json()["id"]
    assert growth_id != value_id

    # 同名分类不会重复创建
    again = client.post("/api/watchlist/categories", json={"name": "成长股"})
    assert again.json()["id"] == growth_id
    assert len(client.get("/api/watchlist/categories").json()) == 2

    client.post("/api/watchlist", json={"code": "sh.600519"})
    patched = client.patch(
        "/api/watchlist/sh.600519",
        json={"category_ids": [growth_id, value_id], "note": "机构调研"},
    )
    item = patched.json()
    assert [c["name"] for c in item["categories"]] == ["低估值", "成长股"]

    listing = client.get("/api/watchlist").json()
    counts = {c["name"]: c["count"] for c in listing["categories"]}
    assert counts == {"成长股": 1, "低估值": 1}
    assert [c["name"] for c in listing["items"][0]["categories"]] == [
        "低估值",
        "成长股",
    ]

    # 不存在的分类 id 会被忽略, 不会写入脏数据
    client.patch("/api/watchlist/sh.600519", json={"category_ids": [99999]})
    assert client.get("/api/watchlist").json()["items"][0]["categories"] == []


def test_delete_category_keeps_stock(
    client: TestClient, charted: Container
) -> None:
    category = client.post("/api/watchlist/categories", json={"name": "观察中"}).json()
    client.post("/api/watchlist", json={"code": "sh.600519"})
    client.patch(
        "/api/watchlist/sh.600519", json={"category_ids": [category["id"]]}
    )

    removed = client.delete(f"/api/watchlist/categories/{category['id']}")
    assert removed.status_code == 200
    assert removed.json()["removed"] is True

    listing = client.get("/api/watchlist").json()
    assert listing["categories"] == []
    # 股票还在, 只是没有分类了
    assert listing["codes"] == ["sh.600519"]
    assert listing["items"][0]["categories"] == []


def test_removing_stock_clears_membership(
    client: TestClient, charted: Container
) -> None:
    category = client.post("/api/watchlist/categories", json={"name": "短线"}).json()
    client.post("/api/watchlist", json={"code": "sh.600519"})
    client.patch(
        "/api/watchlist/sh.600519", json={"category_ids": [category["id"]]}
    )
    assert client.get("/api/watchlist/categories").json()[0]["count"] == 1

    client.delete("/api/watchlist/sh.600519")
    assert client.get("/api/watchlist/categories").json()[0]["count"] == 0
