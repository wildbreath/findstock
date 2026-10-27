"""复盘手填数据必须完整保存, 无效输入及旧页面不能覆盖已有内容。"""

from concurrent.futures import ThreadPoolExecutor
from datetime import date

import pytest
from fastapi.testclient import TestClient

from app.container import Container
from app.main import create_app


@pytest.fixture()
def client(container: Container) -> TestClient:
    return TestClient(create_app(), client=("127.0.0.1", 50000))


def sheet() -> dict:
    return {"revision": 0, "dates": ["2026-10-22", "2026-10-23"], "hidden_dates": [], "rows": [
        {"id": "first", "cells": {"2026-10-22": {"text": "农业", "background": "#7e22a8", "color": "#ffffff", "bold": True}}},
        {"id": "second", "cells": {"2026-10-23": {"text": "股票A\n2板缩量"}}},
    ]}


def test_empty_sheet_and_independent_page(client: TestClient) -> None:
    assert client.get("/api/review-sheet").json() == {"revision": 0, "dates": [], "hidden_dates": [], "rows": [], "collected_dates": []}
    page = client.get("/review")
    assert page.status_code == 200
    assert 'href="/review" aria-current="page"' in page.text
    assert 'id="review-grid"' in page.text
    for path in ("/review", "/static/review.js", "/static/review.css"):
        assert client.get(path).headers["cache-control"] == "no-cache, must-revalidate"


def test_text_colors_layout_and_hidden_dates_survive_restart(client: TestClient) -> None:
    payload = sheet()
    payload["hidden_dates"] = ["2026-10-23"]
    saved = client.put("/api/review-sheet", json=payload)
    assert saved.status_code == 200
    expected = saved.json()
    assert expected["revision"] == 1
    assert expected["rows"][0]["cells"]["2026-10-22"] == {
        **payload["rows"][0]["cells"]["2026-10-22"], "kind": "", "highlight": False, "auto_text": "",
    }
    assert expected["rows"][1]["cells"]["2026-10-23"]["text"] == "股票A\n2板缩量"
    assert TestClient(create_app(), client=("127.0.0.1", 50000)).get("/api/review-sheet").json() == expected
    expected["hidden_dates"] = []
    restored = client.put("/api/review-sheet", json=expected).json()
    assert restored["revision"] == 2
    assert restored["rows"] == expected["rows"]


def test_legacy_sheet_loads_with_unmarked_metadata(client: TestClient, container: Container) -> None:
    payload = sheet()
    container.review_repository.save(payload)
    loaded = client.get("/api/review-sheet").json()
    for row in loaded["rows"]:
        assert row["leader"] is False
        for cell in row["cells"].values():
            assert cell["kind"] == ""
            assert cell["highlight"] is False
    assert loaded["rows"][0]["cells"]["2026-10-22"]["background"] == "#7e22a8"
    assert client.put("/api/review-sheet", json=loaded).status_code == 200


def test_manual_markers_round_trip_and_can_be_removed_without_losing_formats(client: TestClient) -> None:
    payload = sheet()
    payload["rows"][0]["leader"] = True
    payload["rows"][0]["cells"]["2026-10-22"].update(kind="theme", highlight=True)
    payload["rows"][1]["cells"]["2026-10-23"].update(kind="stock")
    response = client.put("/api/review-sheet", json=payload)
    assert response.status_code == 200
    marked = response.json()
    assert TestClient(create_app(), client=("127.0.0.1", 50000)).get("/api/review-sheet").json() == marked
    assert marked["rows"][0]["leader"] is True
    first = marked["rows"][0]["cells"]["2026-10-22"]
    assert first == {**payload["rows"][0]["cells"]["2026-10-22"], "auto_text": ""}
    assert marked["rows"][1]["cells"]["2026-10-23"]["kind"] == "stock"

    marked["rows"][0]["leader"] = False
    first["highlight"] = False
    response = client.put("/api/review-sheet", json=marked)
    assert response.status_code == 200
    restored = response.json()
    assert restored["rows"][0]["leader"] is False
    assert restored["rows"][0]["cells"]["2026-10-22"] == {
        **payload["rows"][0]["cells"]["2026-10-22"], "highlight": False, "auto_text": "",
    }
    assert client.get("/api/review-sheet").json() == restored


def test_stale_page_is_rejected_without_data_loss(client: TestClient) -> None:
    first = client.put("/api/review-sheet", json=sheet()).json()
    stale = sheet()
    stale["rows"] = []
    response = client.put("/api/review-sheet", json=stale)
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "review_conflict"
    assert client.get("/api/review-sheet").json() == first


@pytest.mark.parametrize("change", [
    lambda value: value.update(dates=["2026-10-22", "2026-10-22"]),
    lambda value: value.update(hidden_dates=["2026-01-01"]),
    lambda value: value["rows"][1].update(id="first"),
    lambda value: value["rows"][0]["cells"]["2026-10-22"].update(background="red;display:none"),
    lambda value: value["rows"][0]["cells"]["2026-10-22"].update(color="javascript:alert(1)"),
    lambda value: value["rows"][0]["cells"].update({"2026-10-99": {"text": "错误日期"}}),
    lambda value: value["rows"][0]["cells"]["2026-10-22"].update(text="字" * 2001),
    lambda value: value["rows"][0]["cells"]["2026-10-22"].update(kind="leader"),
    lambda value: value["rows"][0]["cells"]["2026-10-22"].update(highlight="yellow"),
    lambda value: value["rows"][0].update(leader="purple"),
    lambda value: value["rows"][0]["cells"]["2026-10-22"].update(auto_text="字" * 2001),
    lambda value: value["rows"][0].update(tracking={"code": "bj.830001", "theme": "农业", "entry_date": "2026-10-22"}),
    lambda value: value["rows"][0].update(stock_code="sh.600002", tracking={"code": "sh.600001", "theme": "农业", "entry_date": "2026-10-22"}),
    lambda value: value.update(collected_dates=["2026-10-21"]),
    lambda value: value.update(revision=True),
    lambda value: value.update(unrecognized="不能静默丢弃的字段"),
    lambda value: value["rows"][0].update(stock_code="javascript:alert(1)"),
    lambda value: value["rows"][0].update(theme="字" * 2001),
])
def test_invalid_edits_leave_saved_sheet_intact(client: TestClient, change) -> None:
    original = client.put("/api/review-sheet", json=sheet()).json()
    payload = sheet()
    payload["revision"] = 1
    change(payload)
    assert client.put("/api/review-sheet", json=payload).status_code == 422
    assert client.get("/api/review-sheet").json() == original


def test_simultaneous_saves_only_accept_one_revision(container: Container) -> None:
    with ThreadPoolExecutor(max_workers=2) as workers:
        saved = list(workers.map(lambda _: container.review_repository.save(sheet()), range(2)))
    assert sum(value is not None for value in saved) == 1
    assert container.review_repository.get()["revision"] == 1


def test_manual_theme_and_stock_binding_survive_restart(client: TestClient) -> None:
    payload = sheet()
    payload["rows"][0].update(theme="人工题材", stock_code="sz.300001")
    saved = client.put("/api/review-sheet", json=payload)
    assert saved.status_code == 200
    loaded = TestClient(create_app(), client=("127.0.0.1", 50000)).get("/api/review-sheet").json()
    assert loaded == saved.json()
    assert loaded["rows"][0]["tracking"] is None
    assert loaded["rows"][0]["theme"] == "人工题材"
    assert loaded["rows"][0]["stock_code"] == "sz.300001"


def test_same_stock_and_date_can_persist_as_independent_theme_records(client: TestClient) -> None:
    payload = {"revision": 0, "dates": ["2026-10-22", "2026-10-23"], "rows": [
        {"id": "agriculture", "stock_code": "sh.600001", "theme": "农业", "leader": True, "cells": {
            "2026-10-22": {"text": "原题材备注", "highlight": True},
            "2026-10-23": {"text": "甲股", "kind": "stock"},
        }},
        {"id": "finance", "stock_code": "sh.600001", "theme": "金融", "cells": {
            "2026-10-23": {"text": "甲股", "kind": "stock"},
        }},
    ]}
    response = client.put("/api/review-sheet", json=payload)
    assert response.status_code == 200
    saved = response.json()
    loaded = client.get("/api/review-sheet").json()
    assert loaded == saved
    loaded["rows"][1]["cells"]["2026-10-22"] = {"text": "第二题材独立备注"}
    edited = client.put("/api/review-sheet", json=loaded).json()
    assert edited["rows"][0] == saved["rows"][0]
    edited["rows"].pop()
    remaining = client.put("/api/review-sheet", json=edited).json()
    assert remaining["rows"] == [saved["rows"][0]]


def test_date_columns_respect_calendar_and_warn_when_unknown(client: TestClient, container: Container) -> None:
    with container.database.session() as conn:
        container.calendar_repository.upsert_days(conn, [
            (date(2026, 10, 1), False), (date(2026, 10, 2), False),
            (date(2026, 10, 3), True), (date(2026, 10, 4), False),
        ])
    known = client.get("/api/review-sheet/dates?start=2026-10-01&end=2026-10-04").json()
    assert known == {"dates": ["2026-10-03"], "provisional": False}
    fallback = client.get("/api/review-sheet/dates?start=2026-10-01&end=2026-10-05").json()
    assert fallback == {"dates": ["2026-10-03", "2026-10-05"], "provisional": True}
    assert client.get("/api/review-sheet/dates?start=2026-10-05&end=2026-10-01").status_code == 422
    assert client.get("/api/review-sheet/dates?start=2024-01-01&end=2026-10-01").status_code == 422
