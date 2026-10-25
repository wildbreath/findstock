"""策略与条件模块接口测试。"""

from __future__ import annotations

from collections.abc import Iterable
from datetime import date

import pytest
from fastapi.testclient import TestClient

from app.container import Container
from app.main import create_app
from tests.factories import make_bar, make_stock, seed

D0 = date(2026, 9, 14)
D1 = date(2026, 9, 15)
D2 = date(2026, 9, 16)
PREV = date(2026, 9, 11)


@pytest.fixture()
def client(container: Container) -> TestClient:
    return TestClient(create_app())


@pytest.fixture()
def populated(client: TestClient, container: Container) -> Container:
    """两只股票: 一只的量价条件完全满足, 一只普通。"""

    stocks = [
        make_stock("sh.600001", "命中股份", listing_date=date(2015, 1, 1)),
        make_stock("sh.600002", "普通股份", listing_date=date(2015, 1, 1)),
    ]
    bars = [
        make_bar("sh.600001", D0, pct_chg=1.0, volume=1_000_000, close=10.0),
        make_bar("sh.600001", D1, pct_chg=2.0, volume=3_000_000, close=10.2),
        make_bar("sh.600001", D2, pct_chg=3.0, volume=9_000_000, close=10.5),
        make_bar("sh.600002", D0, pct_chg=1.0, volume=1_000_000, close=20.0),
        make_bar("sh.600002", D1, pct_chg=1.0, volume=1_200_000, close=20.2),
        make_bar("sh.600002", D2, pct_chg=1.0, volume=1_500_000, close=20.4),
    ]
    seed(
        container,
        open_days=[PREV, D0, D1, D2],
        stocks=stocks,
        bars=bars,
        names={D2: [(s.code, s.name or "") for s in stocks]},
    )
    return container


def conditions(*items: dict) -> list[dict]:
    return list(items)


def pct_condition(day: str, low, high, inclusive: bool = False) -> dict:
    return {
        "kind": "pct_chg_range",
        "params": {"day": day, "min": low, "max": high, "inclusive": inclusive},
    }


def volume_condition(leg: str, low, high=None) -> dict:
    return {
        "kind": "volume_ratio_range",
        "params": {"leg": leg, "min": low, "max": high, "inclusive": False},
    }


def test_catalog_lists_condition_modules(client: TestClient) -> None:
    payload = client.get("/api/strategy-catalog").json()
    kinds = [item["kind"] for item in payload["conditions"]]
    assert kinds == [
        "pct_chg_range",
        "volume_ratio_range",
        "cumulative_pct_chg_range",
        "close_price_range",
        "amount_range",
        "listed_min_days",
        "not_st",
    ]
    # 每个条件都带参数描述, 前端据此渲染编辑器
    volume = next(item for item in payload["conditions"] if item["kind"] == "volume_ratio_range")
    assert [param["name"] for param in volume["params"]] == [
        "offset",
        "min",
        "max",
        "inclusive",
    ]
    # 时间节点参数带 role 标记, 前端据此渲染 T-1 / T0 这样的符号选择器
    offset_param = volume["params"][0]
    assert offset_param["role"] == "node"
    assert offset_param["default"] == 0


def test_default_strategy_is_seeded(client: TestClient, populated: Container) -> None:
    strategies = client.get("/api/strategies").json()
    assert len(strategies) == 1
    builtin = strategies[0]
    assert builtin["name"] == "标准策略"
    assert builtin["builtin"] is True
    assert [item["kind"] for item in builtin["conditions"]] == [
        "listed_min_days",
        "pct_chg_range",
        "volume_ratio_range",
        "volume_ratio_range",
        "not_st",
    ]
    assert "涨跌幅" in builtin["conditions"][1]["label"]


def test_strategy_crud(client: TestClient, populated: Container) -> None:
    created = client.post(
        "/api/strategies",
        json={
            "name": "只看放量",
            "conditions": conditions(volume_condition("first", 2), volume_condition("second", 2)),
        },
    )
    assert created.status_code == 201
    strategy = created.json()
    assert strategy["name"] == "只看放量"
    assert strategy["condition_count"] == 2
    strategy_id = strategy["id"]

    updated = client.put(
        f"/api/strategies/{strategy_id}",
        json={"name": "只看放量(改)", "conditions": conditions(volume_condition("first", 3))},
    )
    assert updated.status_code == 200
    assert updated.json()["name"] == "只看放量(改)"
    assert updated.json()["condition_count"] == 1

    listing = client.get("/api/strategies").json()
    assert {item["name"] for item in listing} == {"标准策略", "只看放量(改)"}

    removed = client.delete(f"/api/strategies/{strategy_id}")
    assert removed.json()["removed"] is True
    assert {item["name"] for item in client.get("/api/strategies").json()} == {"标准策略"}


def test_strategy_unknown_kind_is_rejected(client: TestClient, populated: Container) -> None:
    response = client.post(
        "/api/strategies",
        json={"name": "非法", "conditions": [{"kind": "no_such", "params": {}}]},
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_request"


def test_screen_with_conditions_only_pct(client: TestClient, populated: Container) -> None:
    """只用一条涨跌幅条件也能筛: 不再被写死的量比条件限制。"""

    response = client.post(
        "/api/screen",
        json={"date": D2.isoformat(), "conditions": conditions(pct_condition("d2", 0, 5))},
    )
    payload = response.json()
    assert payload["hit_count"] == 2  # 两只股票的 D2 涨幅都在 (0, 5)
    assert payload["strategy"]["condition_count"] == 1
    assert [stage["kind"] for stage in payload["funnel"]["stages"]] == [
        "universe",
        "complete_data",
        "pct_chg_range",
    ]


def test_screen_conditions_are_combined(client: TestClient, populated: Container) -> None:
    """多条条件按顺序逐级收窄。"""

    payload = client.post(
        "/api/screen",
        json={
            "date": D2.isoformat(),
            "conditions": conditions(
                volume_condition("first", 2),
                volume_condition("second", 2),
                pct_condition("d2", 0, 7),
            ),
        },
    ).json()
    assert payload["hit_count"] == 1
    counts = [stage["count"] for stage in payload["funnel"]["stages"]]
    assert counts == sorted(counts, reverse=True)  # 逐级收窄
    assert payload["hits"][0]["code"] == "sh.600001"


def test_screen_with_saved_strategy_id(client: TestClient, populated: Container) -> None:
    created = client.post(
        "/api/strategies",
        json={
            "name": "收盘价过滤",
            "conditions": conditions(
                {"kind": "close_price_range", "params": {"min": 15, "max": None}},
            ),
        },
    ).json()

    payload = client.post(
        "/api/screen",
        json={"date": D2.isoformat(), "strategy_id": created["id"]},
    ).json()
    assert payload["hit_count"] == 1
    assert payload["hits"][0]["code"] == "sh.600002"
    assert payload["strategy"]["name"] == "收盘价过滤"

    missing = client.post(
        "/api/screen", json={"date": D2.isoformat(), "strategy_id": 9999}
    )
    assert missing.status_code == 422


def test_screen_with_unknown_condition_kind(client: TestClient, populated: Container) -> None:
    response = client.post(
        "/api/screen",
        json={"date": D2.isoformat(), "conditions": [{"kind": "nope", "params": {}}]},
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_request"


def test_cumulative_and_amount_conditions(client: TestClient, populated: Container) -> None:
    """累计涨跌幅与成交额 (缺失时按不满足处理) 条件。"""

    cumulative = client.post(
        "/api/screen",
        json={
            "date": D2.isoformat(),
            "conditions": conditions(
                {
                    "kind": "cumulative_pct_chg_range",
                    "params": {"min": 6, "max": 7},
                }
            ),
        },
    ).json()
    # 1% -> 2% -> 3% 累计约 6.11%
    assert cumulative["hit_count"] == 1
    assert cumulative["hits"][0]["code"] == "sh.600001"

    amount = client.post(
        "/api/screen",
        json={
            "date": D2.isoformat(),
            "conditions": conditions(
                {"kind": "amount_range", "params": {"min": 1, "max": None}}
            ),
        },
    ).json()
    assert amount["hit_count"] == 0  # 测试数据没有成交额


def test_export_by_conditions(client: TestClient, populated: Container) -> None:
    """导出也要支持模块化条件 (POST), 保证 CSV 与页面结果一致。"""

    body = {
        "date": D2.isoformat(),
        "conditions": conditions(volume_condition("first", 2), volume_condition("second", 2)),
    }
    response = client.post("/api/screen/export", json=body)
    assert response.status_code == 200
    assert "text/csv" in response.headers["content-type"]
    text = response.content.decode("utf-8-sig")
    assert "命中股份" in text
    assert "普通股份" not in text

    strict = client.post(
        "/api/screen/export",
        json={
            "date": D2.isoformat(),
            "conditions": conditions(volume_condition("first", 50)),
        },
    )
    assert "命中股份" not in strict.content.decode("utf-8-sig")


def test_amount_condition_accepts_present_amount(
    client: TestClient, populated: Container
) -> None:
    with populated.database.session() as conn:
        populated.bar_repository.upsert_bars(
            conn,
            [
                make_bar("sh.600001", D2, pct_chg=3.0, volume=9_000_000, close=10.5),
            ],
        )
    # 上面 upsert 不带成交额, 这里直接写库模拟有成交额的情况
    with populated.database.session() as conn:
        conn.execute(
            "UPDATE daily_bar SET amount = ? WHERE code = ? AND trade_date = ?",
            (50_000_000.0, "sh.600001", D2.isoformat()),
        )

    payload = client.post(
        "/api/screen",
        json={
            "date": D2.isoformat(),
            "conditions": conditions(
                {"kind": "amount_range", "params": {"min": 4000, "max": 6000}}
            ),
        },
    ).json()
    assert payload["hit_count"] == 1


def test_removing_all_strategies_reseeds_default(
    client: TestClient, populated: Container
) -> None:
    builtin = client.get("/api/strategies").json()[0]
    assert client.delete(f"/api/strategies/{builtin['id']}").json()["removed"] is True

    strategies = client.get("/api/strategies").json()
    assert len(strategies) == 1
    assert strategies[0]["builtin"] is True


def _kinds(strategies: Iterable[dict]) -> list[str]:
    return [item["kind"] for item in next(iter(strategies))["conditions"]]


def test_month_scan_collects_hits_with_screen_date(
    client: TestClient, populated: Container
) -> None:
    """整月扫描: 用 T0 遍历该月每个交易日, 每条命中都带"选出日"。"""

    response = client.post(
        "/api/screen/scan",
        json={
            "month": "2026-09",
            "conditions": conditions(volume_condition("second", 2)),
        },
    )
    assert response.status_code == 200, response.text[:400]
    payload = response.json()
    assert payload["month"] == "2026-09"
    # 交易日只有 D0/D1/D2 三天, 且其中两天数据不全 -> 至少能跑通并统计
    assert payload["scanned_days"] + payload["skipped_days"] >= 1
    assert payload["hit_count"] == len(payload["hits"])
    for hit in payload["hits"]:
        assert hit["screen_date"] in {"2026-09-14", "2026-09-15", "2026-09-16"}
        assert hit["code"] and hit["name"] and hit["board_label"]
    assert payload["strategy"]["name"] == "自定义条件"


def test_month_scan_export_has_four_columns(
    client: TestClient, populated: Container
) -> None:
    response = client.post(
        "/api/screen/scan/export",
        json={
            "month": "2026-09",
            "conditions": conditions(volume_condition("second", 2)),
        },
    )
    assert response.status_code == 200
    assert "text/csv" in response.headers["content-type"]
    header = response.content.decode("utf-8-sig").splitlines()[0]
    assert header == "选出日(T0),股票代码,股票简称,板块"


def test_month_scan_rejects_bad_month(client: TestClient, populated: Container) -> None:
    response = client.post("/api/screen/scan", json={"month": "2026/09"})
    assert response.status_code == 422

