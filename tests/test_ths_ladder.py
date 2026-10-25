"""历史涨停池必须完整分页，连续板不能用几天几板代替。"""

from copy import deepcopy
from datetime import date, datetime, timedelta, timezone

import pytest

from app.providers import ths_ladder

DAY = date(2025, 10, 16)


def row(symbol="600001", **extra):
    return {"code": symbol, "name": "测试股份", "latest": 11, "change_rate": 10,
            "open_num": 1, "order_amount": 3000, "turnover_rate": 2.5,
            "high_days": "4天3板", "first_limit_up_time": str(int(datetime(2025, 10, 16, 9, 30,
                tzinfo=timezone(timedelta(hours=8))).timestamp())), **extra}


def install(monkeypatch, rows, groups, mutate=lambda body, page: None):
    calls = []

    def get(url, *, params, **kwargs):
        calls.append((url, params))
        if url.endswith("continuous_limit_up"):
            data = deepcopy(groups)
        else:
            page = params["page"]
            data = {"date": "20251016", "info": deepcopy(rows[(page - 1) * 200:page * 200]),
                    "page": {"total": len(rows), "count": (len(rows) + 199) // 200, "page": page}}
            mutate(data, page)
        class Response:
            def raise_for_status(self): pass
            def json(self): return {"status_code": 0, "data": data}
        return Response()
    monkeypatch.setattr(ths_ladder.requests, "get", get)
    return calls


def test_source_consecutive_and_units(monkeypatch):
    install(monkeypatch, [row(), row("000001", high_days="首板")],
            [{"height": 2, "number": 1, "code_list": [{"code": "600001", "continue_num": 2}]}])
    items = ths_ladder.fetch_ths_ladder(DAY, 1)
    assert [item.consecutive for item in items] == [2, 1]
    assert items[0].first_seal == "09:30:00" and items[0].price == 11
    assert items[0].seal_funds == 3000 and items[0].amount is None and items[0].industry == ""


def test_paginates_all_rows(monkeypatch):
    rows = [row(f"{600000 + index}", high_days="首板") for index in range(201)]
    calls = install(monkeypatch, rows, [])
    assert len(ths_ladder.fetch_ths_ladder(DAY, 1)) == 201
    assert [params["page"] for url, params in calls if url.endswith("limit_up_pool")] == [1, 2]


@pytest.mark.parametrize("problem", ["date", "short_page", "duplicate", "missing_group", "time"])
def test_rejects_incomplete_or_inconsistent_data(monkeypatch, problem):
    rows, groups = [row()], []
    def mutate(data, page):
        if problem == "date": data["date"] = "20261016"
        if problem == "short_page": data["info"] = []
    if problem == "duplicate": rows.append(row())
    if problem == "missing_group": groups = [{"height": 2, "number": 1, "code_list": [{"code": "600099", "continue_num": 2}]}]
    if problem == "time": rows[0]["first_limit_up_time"] = "1792114286"
    install(monkeypatch, rows, groups, mutate)
    with pytest.raises(ValueError):
        ths_ladder.fetch_ths_ladder(DAY, 1)


def test_empty_pool_does_not_need_continuous_statistics(monkeypatch):
    calls = install(monkeypatch, [], [])
    assert ths_ladder.fetch_ths_ladder(DAY, 1) == []
    assert len(calls) == 1


def test_continuous_statistics_take_precedence_over_incorrect_historical_tags(monkeypatch):
    install(monkeypatch, [row(high_days="2天2板"), row("000001", high_days="17天17板")],
            [{"height": 18, "number": 1, "code_list": [{"code": "000001", "continue_num": 18}]}])
    assert [item.consecutive for item in ths_ladder.fetch_ths_ladder(DAY, 1)] == [1, 18]
