"""联合示例必须由同一组量价数据满足所有条件。"""

from decimal import Decimal

import pytest
from fastapi.testclient import TestClient

from app.domain.conditions import DEFAULT_STRATEGY, ConditionSpec
from app.domain.strategy_preview import build_strategy_preview
from app.main import create_app


@pytest.fixture()
def client(container):
    return TestClient(create_app(), client=("127.0.0.1", 50000))


def spec(kind, **params):
    return ConditionSpec(kind, params)


def test_joint_example_contains_all_seven_kinds():
    result = build_strategy_preview((
        spec("pct_chg_range", offset=0, span=3, min=1, max=3),
        spec("cumulative_pct_chg_range", offset=0, span=3, min=5, max=8),
        spec("volume_ratio_range", offset=-1, min=2, max=3),
        spec("volume_ratio_range", offset=0, min=.4, max=.8),
        spec("close_price_range", offset=0, min=15, max=25),
        spec("amount_range", offset=0, min=1000, max=5000),
        spec("listed_min_days", days=250),
        spec("not_st", offset=0),
    ))
    assert result["status"] == "ok", result
    assert len(result["checks"]) == 8
    assert all(check["passed"] for check in result["checks"])
    bars = {bar["offset"]: bar for bar in result["bars"]}
    active = [bars[node] for node in (-2, -1, 0)]
    assert all(1 < bar["pct_chg"] < 3 for bar in active)
    factor = Decimal(1)
    for bar in active:
        factor *= 1 + Decimal(str(bar["pct_chg"])) / 100
    assert 5 < (factor - 1) * 100 < 8
    assert 2 < bars[-1]["volume"] / bars[-2]["volume"] < 3
    assert .4 < bars[0]["volume"] / bars[-1]["volume"] < .8
    assert 15 < bars[0]["close"] < 25
    assert 1000 < bars[0]["amount"] < 5000
    for node in (-2, -1, 0):
        assert abs((bars[node]["close"] / bars[node - 1]["close"] - 1) * 100 - bars[node]["pct_chg"]) < 1e-7


def test_standard_strategy_is_jointly_satisfied():
    result = build_strategy_preview(DEFAULT_STRATEGY.conditions)
    assert result["status"] == "ok"
    assert all(item["passed"] for item in result["checks"])


def test_same_day_volume_conflict_has_no_fake_candles():
    result = build_strategy_preview((
        spec("volume_ratio_range", offset=0, min=1.1, max=3, inclusive=True),
        spec("volume_ratio_range", offset=0, min=0, max=.7),
    ))
    assert result["status"] == "conflict"
    assert result["conflicts"] == [0, 1]
    assert result["bars"] == []


def test_cross_day_conflict_never_claims_success():
    result = build_strategy_preview((
        spec("pct_chg_range", offset=0, span=3, min=0, max=1),
        spec("cumulative_pct_chg_range", offset=0, span=3, min=20, max=25),
    ))
    assert result["status"] != "ok"
    assert result["bars"] == []


def test_inclusive_touching_bounds_and_cumulative_rounding():
    result = build_strategy_preview((
        spec("pct_chg_range", offset=0, span=1, min=2, max=3, inclusive=True),
        spec("pct_chg_range", offset=0, span=1, min=1, max=2, inclusive=True),
        spec("cumulative_pct_chg_range", offset=0, span=1, min=2, max=2, inclusive=True),
        spec("close_price_range", offset=0, min=15, max=15, inclusive=True),
    ))
    assert result["status"] == "ok", result
    current = next(bar for bar in result["bars"] if bar["offset"] == 0)
    assert current["pct_chg"] == 2
    assert current["close"] == 15


def test_empty_quantized_cumulative_interval_is_rejected():
    result = build_strategy_preview((spec("cumulative_pct_chg_range", offset=0, span=3, min=.00001, max=.00002),))
    assert result["status"] == "conflict"
    assert result["bars"] == []


@pytest.mark.parametrize("daily,total", [(.00005, 0), (.00015, .0002)])
def test_cumulative_uses_backend_half_even_rounding(daily, total):
    result = build_strategy_preview((
        spec("pct_chg_range", offset=0, span=1, min=daily, max=daily, inclusive=True),
        spec("cumulative_pct_chg_range", offset=0, span=1, min=total, max=total, inclusive=True),
    ))
    assert result["status"] == "ok", result
    assert all(check["passed"] for check in result["checks"])


def test_extreme_offsets_and_null_span():
    result = build_strategy_preview((
        spec("pct_chg_range", offset=-60, span=10, min=-3, max=-1),
        spec("pct_chg_range", offset=60, span=None, min=1, max=3),
    ))
    assert result["status"] == "ok", result
    bars = {bar["offset"]: bar for bar in result["bars"]}
    assert all(1 < bars[node]["pct_chg"] < 3 for node in (58, 59, 60))
    assert all(-3 < bars[node]["pct_chg"] < -1 for node in range(-69, -59))


def test_preview_api_does_not_save(client):
    before = client.get("/api/strategies").json()
    response = client.post("/api/strategies/preview", json={"conditions": [{"kind": "not_st", "params": {"offset": 0}}]})
    assert response.status_code == 200
    assert response.json()["status"] == "ok"
    assert client.get("/api/strategies").json() == before


@pytest.mark.parametrize("params", [{"offset": 100000}, {"span": "bad"}, {"min": "NaN"}, {"min": True}])
def test_preview_api_validates_numeric_input(client, params):
    response = client.post("/api/strategies/preview", json={"conditions": [{"kind": "pct_chg_range", "params": params}]})
    assert response.status_code == 422
