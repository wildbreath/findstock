"""HTTP 接口测试。"""

from __future__ import annotations

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
    """基于临时数据库的测试客户端。"""

    return TestClient(create_app())


@pytest.fixture()
def populated(client: TestClient, container: Container) -> Container:
    """写入一份最小可筛选数据集。"""

    stocks = [
        make_stock("sh.600001", "命中股份", listing_date=date(2015, 1, 1)),
        make_stock("sh.600002", "普通股份", listing_date=date(2015, 1, 1)),
    ]
    bars = [
        make_bar("sh.600001", D0, pct_chg=1.0, volume=1_000_000),
        make_bar("sh.600001", D1, pct_chg=2.0, volume=3_000_000),
        make_bar("sh.600001", D2, pct_chg=3.0, volume=9_000_000),
        make_bar("sh.600002", D0, pct_chg=1.0, volume=1_000_000),
        make_bar("sh.600002", D1, pct_chg=1.0, volume=1_200_000),
        make_bar("sh.600002", D2, pct_chg=1.0, volume=1_500_000),
    ]
    seed(
        container,
        open_days=[PREV, D0, D1, D2],
        closed_days=[date(2026, 9, 12)],
        stocks=stocks,
        bars=bars,
        names={D2: [(s.code, s.name or "") for s in stocks]},
    )
    return container


def test_health(client: TestClient) -> None:
    response = client.get("/api/health")
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "ok"
    assert payload["initialized"] is False


def test_coverage_before_init(client: TestClient) -> None:
    response = client.get("/api/data/coverage")
    assert response.status_code == 200
    payload = response.json()
    assert payload["trading_days"] == 0
    assert payload["bar_count"] == 0


def test_calendar_endpoint(client: TestClient, populated: Container) -> None:
    response = client.get("/api/calendar?recent=5")
    assert response.status_code == 200
    payload = response.json()
    assert payload["recent_trading_days"][0] == D2.isoformat()


def test_screen_success(client: TestClient, populated: Container) -> None:
    response = client.post("/api/screen", json={"date": D2.isoformat()})
    assert response.status_code == 200
    payload = response.json()

    assert payload["selected_date"] == D2.isoformat()
    assert payload["window"] == {
        "selected_date": D2.isoformat(),
        "d0": D0.isoformat(),
        "d1": D1.isoformat(),
        "d2": D2.isoformat(),
        "previous_trading_day": PREV.isoformat(),
        "anchor": D2.isoformat(),
        "nodes": {
            "-2": D0.isoformat(),
            "-1": D1.isoformat(),
            "0": D2.isoformat(),
        },
    }
    assert payload["hit_count"] == 1
    hit = payload["hits"][0]
    assert hit["code"] == "sh.600001"
    assert hit["symbol"] == "600001"
    assert hit["name"] == "命中股份"
    assert hit["first_volume_ratio"] == pytest.approx(3.0)
    assert hit["second_volume_ratio"] == pytest.approx(3.0)
    assert hit["d0"]["trade_date"] == D0.isoformat()
    assert hit["d1"]["trade_date"] == D1.isoformat()
    assert hit["d2"]["trade_date"] == D2.isoformat()
    assert hit["d0"]["pct_chg"] == pytest.approx(1.0)
    assert hit["d0"]["volume"] == 1_000_000
    assert payload["funnel"]["universe"] == 2
    assert payload["funnel"]["not_st"] == 1
    assert payload["message"] is None


def test_screen_get_alias(client: TestClient, populated: Container) -> None:
    response = client.get(f"/api/screen?date={D2.isoformat()}")
    assert response.status_code == 200
    assert response.json()["hit_count"] == 1


def test_screen_non_trading_day(client: TestClient, populated: Container) -> None:
    response = client.post("/api/screen", json={"date": "2026-09-12"})
    assert response.status_code == 422
    error = response.json()["error"]
    assert error["code"] == "not_a_trading_day"
    assert error["details"]["suggested_date"] == D2.isoformat()


def test_screen_data_not_available(client: TestClient, populated: Container) -> None:
    with populated.database.session() as conn:
        conn.execute("DELETE FROM synced_day WHERE trade_date = ?", (D1.isoformat(),))
    response = client.post("/api/screen", json={"date": D2.isoformat()})
    assert response.status_code == 409
    error = response.json()["error"]
    assert error["code"] == "data_not_available"
    assert error["details"]["missing_dates"] == [D1.isoformat()]
    assert error["details"]["required_dates"] == [
        D0.isoformat(),
        D1.isoformat(),
        D2.isoformat(),
    ]


def test_screen_calendar_not_initialized(client: TestClient) -> None:
    response = client.post("/api/screen", json={"date": D2.isoformat()})
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "calendar_not_initialized"


def test_screen_invalid_payload(client: TestClient) -> None:
    response = client.post("/api/screen", json={"date": "not-a-date"})
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"


def test_screen_empty_result_message(client: TestClient, populated: Container) -> None:
    response = client.post("/api/screen", json={"date": D2.isoformat()})
    assert response.json()["message"] is None

    with populated.database.session() as conn:
        populated.bar_repository.upsert_bars(
            conn, [make_bar("sh.600001", D2, pct_chg=0.0, volume=9_000_000)]
        )
    response = client.post("/api/screen", json={"date": D2.isoformat()})
    payload = response.json()
    assert payload["hit_count"] == 0
    assert "没有满足全部条件的股票" in payload["message"]


def test_rules_endpoint(client: TestClient) -> None:
    response = client.get("/api/rules")
    assert response.status_code == 200
    payload = response.json()
    assert payload["thresholds"]["volume_ratio_strictly_greater_than"] == 2.0
    assert payload["thresholds"]["pct_chg_strictly_less_than"] == 7.0
    # 前端参数面板据此渲染: 默认值 + 取值范围。
    assert payload["defaults"] == {
        "first_volume_ratio_min": 2.0,
        "first_volume_ratio_max": None,
        "first_volume_ratio_inclusive": False,
        "second_volume_ratio_min": 2.0,
        "second_volume_ratio_max": None,
        "second_volume_ratio_inclusive": False,
        "pct_chg_min": 0.0,
        "pct_chg_max": 7.0,
        "pct_chg_inclusive": False,
        "exclude_st": True,
        "exclude_newly_listed": True,
    }
    assert payload["limits"]["first_volume_ratio_min"]["max"] == 100
    assert payload["limits"]["first_volume_ratio_max"]["optional"] is True


def test_screen_uses_default_params_when_omitted(
    client: TestClient, populated: Container
) -> None:
    response = client.post("/api/screen", json={"date": D2.isoformat()})
    payload = response.json()
    assert payload["hit_count"] == 1
    assert payload["params"]["first_volume_ratio_min"] == 2.0
    assert payload["params"]["pct_chg_max"] == 7.0


def test_screen_with_stricter_params_rejects_more(
    client: TestClient, populated: Container
) -> None:
    """把量比下限调到 4 倍后, 实际只有 3 倍的股票就不该再命中。"""

    response = client.post(
        "/api/screen",
        json={
            "date": D2.isoformat(),
            "params": {
                "first_volume_ratio_min": 4,
                "second_volume_ratio_min": 4,
            },
        },
    )
    payload = response.json()
    assert payload["hit_count"] == 0
    assert payload["params"]["first_volume_ratio_min"] == 4.0
    assert any("量比未落在区间内" in label for label in payload["rejection_counts"])


def test_screen_with_looser_params_accepts_more(
    client: TestClient, populated: Container
) -> None:
    """放宽量比与涨幅区间后, 原本被剔除的股票应当命中。"""

    response = client.post(
        "/api/screen",
        json={
            "date": D2.isoformat(),
            "params": {
                "first_volume_ratio_min": 1.1,
                "second_volume_ratio_min": 1.1,
                "pct_chg_min": -5,
                "pct_chg_max": 9,
            },
        },
    )
    payload = response.json()
    assert payload["hit_count"] == 2
    assert payload["params"]["pct_chg_max"] == 9.0
    assert "9" in payload["criteria"]["pct_chg"]


def test_screen_rejects_invalid_params(
    client: TestClient, populated: Container
) -> None:
    response = client.post(
        "/api/screen",
        json={
            "date": D2.isoformat(),
            "params": {"pct_chg_min": 8, "pct_chg_max": 7},
        },
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"


def test_screen_ratio_interval_upper_bound(
    client: TestClient, populated: Container
) -> None:
    """量比区间带上限: 命中股票的量比都是 3 倍, 卡在 2.9 就应被排除。"""

    capped = client.post(
        "/api/screen",
        json={
            "date": D2.isoformat(),
            "params": {
                "first_volume_ratio_min": 2,
                "first_volume_ratio_max": 2.9,
                "second_volume_ratio_min": 2,
                "second_volume_ratio_max": 2.9,
            },
        },
    ).json()
    assert capped["hit_count"] == 0
    assert any("量比未落在区间内" in label for label in capped["rejection_counts"])

    inclusive = client.post(
        "/api/screen",
        json={
            "date": D2.isoformat(),
            "params": {
                "first_volume_ratio_min": 2,
                "first_volume_ratio_max": 3,
                "first_volume_ratio_inclusive": True,
                "second_volume_ratio_min": 2,
                "second_volume_ratio_max": 3,
                "second_volume_ratio_inclusive": True,
            },
        },
    ).json()
    assert inclusive["hit_count"] == 1
    # 勾选含边界后两侧都是闭区间
    assert "[2 倍, 3 倍]" in inclusive["criteria"]["volume_ratio"]


def test_screen_pct_interval_accepts_negative_lower_bound(
    client: TestClient, populated: Container
) -> None:
    """涨跌幅写成负到正也有效, 并且能排除超出上限的股票。"""

    swing = client.post(
        "/api/screen",
        json={
            "date": D2.isoformat(),
            "params": {
                "pct_chg_min": -5,
                "pct_chg_max": 9,
                "pct_chg_inclusive": True,
            },
        },
    ).json()
    assert swing["hit_count"] == 1
    assert "[-5%, +9%]" in swing["criteria"]["pct_chg"]
    assert swing["params"]["pct_chg_min"] == -5.0

    too_low = client.post(
        "/api/screen",
        json={"date": D2.isoformat(), "params": {"pct_chg_max": 1}},
    ).json()
    assert too_low["hit_count"] == 0


def test_screen_rejects_broken_interval(
    client: TestClient, populated: Container
) -> None:
    """下限大于上限, 或上下限相等却没勾含边界, 都要被拒绝。"""

    reversed_range = client.post(
        "/api/screen",
        json={
            "date": D2.isoformat(),
            "params": {"first_volume_ratio_min": 5, "first_volume_ratio_max": 3},
        },
    )
    assert reversed_range.status_code == 422

    equal_without_inclusive = client.post(
        "/api/screen",
        json={
            "date": D2.isoformat(),
            "params": {"pct_chg_min": 5, "pct_chg_max": 5},
        },
    )
    assert equal_without_inclusive.status_code == 422

    equal_with_inclusive = client.post(
        "/api/screen",
        json={
            "date": D2.isoformat(),
            "params": {
                "pct_chg_min": 1,
                "pct_chg_max": 1,
                "pct_chg_inclusive": True,
            },
        },
    )
    assert equal_with_inclusive.status_code == 200
    assert equal_with_inclusive.json()["hit_count"] == 0


def test_get_screen_accepts_query_params(
    client: TestClient, populated: Container
) -> None:
    response = client.get(
        f"/api/screen?date={D2.isoformat()}&first_volume_ratio_min=4"
        "&second_volume_ratio_min=4"
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["hit_count"] == 0
    assert payload["params"]["second_volume_ratio_min"] == 4.0


def test_get_screen_rejects_invalid_query_params(
    client: TestClient, populated: Container
) -> None:
    response = client.get(
        f"/api/screen?date={D2.isoformat()}&pct_chg_min=8&pct_chg_max=7"
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_request"


def test_export_csv_respects_params(
    client: TestClient, populated: Container
) -> None:
    """导出必须与页面上看到的结果一致, 因此同样接收选股参数。"""

    empty = client.get(
        f"/api/screen/export?date={D2.isoformat()}&first_volume_ratio_min=4"
        "&second_volume_ratio_min=4"
    )
    assert "命中股份" not in empty.content.decode("utf-8-sig")

    full = client.get(f"/api/screen/export?date={D2.isoformat()}")
    assert "命中股份" in full.content.decode("utf-8-sig")


def test_export_csv(client: TestClient, populated: Container) -> None:
    response = client.get(f"/api/screen/export?date={D2.isoformat()}")
    assert response.status_code == 200
    assert "text/csv" in response.headers["content-type"]
    body = response.content.decode("utf-8-sig")
    assert body.splitlines()[0].startswith("股票代码,股票简称,板块,T-2日期")
    assert "sh.600001" in body
    assert "命中股份" in body


def test_sync_status_empty(client: TestClient) -> None:
    response = client.get("/api/data/sync/status")
    assert response.status_code == 200
    assert response.json() is None


def test_start_targeted_sync_requires_dates(client: TestClient, populated: Container) -> None:
    response = client.post("/api/data/sync", json={"mode": "targeted", "dates": []})
    assert response.status_code == 422
    error = response.json()["error"]
    assert error["code"] == "invalid_request"


def test_start_sync_rejects_unknown_mode(client: TestClient) -> None:
    response = client.post("/api/data/sync", json={"mode": "nonsense"})
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"


def test_screen_page_is_served(client: TestClient) -> None:
    response = client.get("/screen")
    assert response.status_code == 200
    assert "沪深A股自动筛选系统" in response.text
    assert 'id="screen-date-title"' in response.text
    assert 'id="strategy-name"' not in response.text
    assert 'id="condition-palette"' not in response.text
    assert 'id="edit-strategy"' in response.text
    assert 'id="condition-list"' in response.text
    assert 'id="criteria-save"' in response.text
    assert 'id="criteria-reset"' in response.text
    assert client.get("/screen/stocks").text == response.text


def test_data_page_is_served(client: TestClient) -> None:
    response = client.get("/data")
    assert response.status_code == 200
    assert "本地数据" in response.text
    # 数据页不该再出现选股页的日历
    assert 'id="calendar-grid"' not in response.text


def test_watchlist_page_is_served(client: TestClient) -> None:
    response = client.get("/watchlist")
    assert response.status_code == 200
    assert "自选股" in response.text
    # 卡片清单 + 分类栏 + 备注输入都在页面上
    assert 'id="watchlist-list"' in response.text
    assert 'id="category-chips"' in response.text
    assert 'id="category-create-form"' in response.text
    assert 'id="calendar-grid"' not in response.text


def test_overview_page_is_served(client: TestClient) -> None:
    response = client.get("/")
    assert response.status_code == 200
    assert "连板板块概览" in response.text
    assert 'id="overview-level"' in response.text
    assert 'id="overview-subsectors"' in response.text
    assert 'id="calendar-grid"' not in response.text


def test_strategy_page_redirects_to_strategy_design(client: TestClient) -> None:
    response = client.get("/strategy", follow_redirects=False)
    assert response.status_code == 307
    assert response.headers["location"] == "/screen/strategies"
    html = client.get("/screen/strategies").text
    assert "条件选股" in html
    for element in ("strategy-name", "strategy-save", "strategy-delete", "condition-palette", "condition-list", "strategy-list", "strategy-search", "strategy-map", "strategy-map-detail", "strategy-guide-list"):
        assert f'id="{element}"' in html
    assert 'id="calendar-grid"' not in html
    assert 'id="screen-button"' not in html
    assert 'id="results-panel"' not in html
    assert "/static/screen.js?v=" not in html
    for path, current in (("/screen/stocks", "/screen/stocks"), ("/screen/strategies", "/screen/strategies")):
        page = client.get(path).text
        assert f'href="{current}" aria-current="page"' in page
        assert 'href="/screen/stocks"' in page
        assert 'href="/screen/strategies"' in page


def test_both_pages_share_the_navigation(client: TestClient) -> None:
    """所有页面共用导航, 且互相指得通。"""

    for path in ("/", "/screen", "/screen/stocks", "/screen/strategies", "/strategy", "/data", "/watchlist", "/stock-ladder", "/multi-chart", "/review"):
        html = client.get(path).text
        assert 'href="/"' in html
        assert 'href="/screen"' in html
        assert 'href="/strategy"' not in html
        assert 'href="/data"' in html
        assert 'href="/watchlist"' in html
        assert 'class="app-sidebar"' in html
        assert "side-link" in html
        assert 'href="/stock-ladder"' in html
        assert 'href="/multi-chart"' in html
        assert 'href="/review"' in html
        assert html.count("side-link") == 7
        assert html.index('href="/"') < html.index('href="/stock-ladder"')
        assert html.index('href="/"') < html.index('href="/screen"') < html.index('href="/stock-ladder"')


def test_pages_embed_asset_version(client: TestClient) -> None:
    """页面里的静态资源要带版本号, 否则新页面会配上浏览器缓存的旧脚本。"""

    for path in ("/", "/screen", "/screen/stocks", "/screen/strategies", "/strategy", "/data", "/watchlist", "/stock-ladder", "/multi-chart", "/review"):
        response = client.get(path)
        assert response.status_code == 200
        assert "__ASSET_VERSION__" not in response.text
        assert "/static/styles.css?v=" in response.text
    assert "/static/screen.js?v=" in client.get("/screen").text
    assert "/static/chart.js?v=" in client.get("/screen").text
    assert "/static/conditions.js?v=" in client.get("/screen").text
    assert "/static/strategy-library.js?v=" in client.get("/screen/stocks").text
    assert "/static/strategy-library.js?v=" in client.get("/screen/strategies").text
    assert "/static/strategy.js?v=" in client.get("/screen/strategies").text
    assert "/static/strategy-map.js?v=" in client.get("/screen/strategies").text
    assert "/static/overview.js?v=" in client.get("/").text
    assert "/static/stock-sectors.js?v=" in client.get("/").text
    assert "/static/data.js?v=" in client.get("/data").text
    assert "/static/watchlist.js?v=" in client.get("/watchlist").text
    multi = client.get("/multi-chart").text
    assert "/static/multi-chart.js?v=" in multi
    assert "/static/multi-chart-interactions.js?v=" in multi
    assert "/static/multi-chart.css?v=" in multi
    assert 'id="multi-grid"' in multi and 'id="multi-picker"' in multi
    assert 'href="/multi-chart?source=watchlist"' in client.get("/watchlist").text
    assert 'href="/multi-chart?source=ladder"' in client.get("/stock-ladder").text


def test_frontend_assets_disable_cache_reuse(client: TestClient) -> None:
    """页面与静态资源必须每次回源校验, 避免"改了前端但页面没变"。"""

    responses = [
        client.get("/screen/stocks"),
        client.get("/screen/strategies"),
        client.get("/static/strategy.js"),
        client.get("/static/strategy-map.js"),
        client.get("/static/strategy-library.js"),
        client.get("/"),
        client.get("/strategy"),
        client.get("/data"),
        client.get("/watchlist"),
        client.get("/stock-ladder"),
        client.get("/multi-chart"),
        client.get("/static/multi-chart.js"),
        client.get("/static/multi-chart-interactions.js"),
        client.get("/static/multi-chart.css"),
        client.get("/static/ladder.js"),
        client.get("/static/ladder.css"),
        client.get("/static/styles.css"),
        client.get("/static/shared.js"),
        client.get("/static/chart.js"),
        client.get("/static/conditions.js"),
        client.get("/static/screen.js"),
        client.get("/screen"),
        client.get("/static/overview.js"),
        client.get("/static/data.js"),
        client.get("/static/watchlist.js"),
    ]
    for response in responses:
        assert response.status_code == 200
        assert "no-cache" in response.headers["cache-control"]
