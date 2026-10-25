"""筛选服务集成测试 (临时数据库 + 构造数据, 不访问网络)。"""

from __future__ import annotations

from datetime import date

import pytest

from app.container import Container
from app.core.errors import DataNotAvailableError
from app.domain.enums import RejectionReason, StBasis
from app.domain.models import DailyBar
from app.services.screener_service import ScreenerService
from tests.factories import make_bar, make_stock, seed

D0 = date(2026, 9, 14)
D1 = date(2026, 9, 15)
D2 = date(2026, 9, 16)
PREV = date(2026, 9, 11)


class StubNameHistory:
    """替身: 直接给出历史简称, 避免测试触网。"""

    def __init__(self, mapping: dict[str, list[str]] | None = None) -> None:
        self.mapping = mapping or {}
        self.calls: list[str] = []

    def history_for(self, code: str) -> list[str]:
        self.calls.append(code)
        return self.mapping.get(code, [])


def triple(
    code: str,
    *,
    volumes: tuple[int, int, int],
    pcts: tuple[float, float, float],
) -> list[DailyBar]:
    """构造某只股票的三日行情。"""

    return [
        make_bar(code, D0, pct_chg=pcts[0], volume=volumes[0]),
        make_bar(code, D1, pct_chg=pcts[1], volume=volumes[1]),
        make_bar(code, D2, pct_chg=pcts[2], volume=volumes[2]),
    ]


@pytest.fixture()
def market(container: Container) -> Container:
    """构造一个包含多种情形的小型市场 (含 D2 当天简称快照)。"""

    stocks = [
        make_stock("sh.600001", "命中股份", listing_date=date(2015, 1, 1)),
        make_stock("sh.600002", "量比不足", listing_date=date(2015, 1, 1)),
        make_stock("sh.600003", "涨幅为零", listing_date=date(2015, 1, 1)),
        make_stock("sh.600004", "涨幅达七", listing_date=date(2015, 1, 1)),
        make_stock("sh.600005", "*ST退市风险", listing_date=date(2015, 1, 1)),
        make_stock("sh.600006", "新股上市", listing_date=D0),
        make_stock("sh.600007", "停牌一天", listing_date=date(2015, 1, 1)),
        make_stock("sh.600008", "也命中", listing_date=date(2015, 1, 1)),
    ]
    bars: list[DailyBar] = []
    bars += triple("sh.600001", volumes=(1_000_000, 3_000_000, 9_000_000), pcts=(1.0, 2.0, 3.0))
    bars += triple("sh.600002", volumes=(1_000_000, 2_000_000, 4_000_000), pcts=(1.0, 2.0, 3.0))
    bars += triple("sh.600003", volumes=(1_000_000, 3_000_000, 9_000_000), pcts=(1.0, 0.0, 3.0))
    bars += triple("sh.600004", volumes=(1_000_000, 3_000_000, 9_000_000), pcts=(1.0, 2.0, 7.0))
    bars += triple("sh.600005", volumes=(1_000_000, 3_000_000, 9_000_000), pcts=(1.0, 2.0, 3.0))
    bars += triple("sh.600006", volumes=(1_000_000, 3_000_000, 9_000_000), pcts=(1.0, 2.0, 3.0))
    bars += [
        make_bar("sh.600007", D0, pct_chg=1.0, volume=1_000_000),
        make_bar("sh.600007", D1, pct_chg=None, volume=None, close=None),
        make_bar("sh.600007", D2, pct_chg=3.0, volume=9_000_000),
    ]
    bars += triple("sh.600008", volumes=(2_000_000, 5_000_000, 11_000_000), pcts=(0.5, 1.5, 6.9))

    seed(
        container,
        open_days=[PREV, D0, D1, D2],
        stocks=stocks,
        bars=bars,
        names={D2: [(stock.code, stock.name or "") for stock in stocks]},
    )
    return container


def test_screen_finds_only_matching_stocks(market: Container) -> None:
    result = market.screener_service.screen(D2)
    assert {hit.code for hit in result.hits} == {"sh.600001", "sh.600008"}
    assert result.hit_count == 2


def test_screen_reports_window(market: Container) -> None:
    result = market.screener_service.screen(D2)
    assert (result.window.d0, result.window.d1, result.window.d2) == (D0, D1, D2)
    assert result.selected_date == D2


def test_screen_hit_payload(market: Container) -> None:
    result = market.screener_service.screen(D2)
    hit = next(hit for hit in result.hits if hit.code == "sh.600001")
    assert hit.name == "命中股份"
    assert (hit.d0_bar.trade_date, hit.d1_bar.trade_date, hit.d2_bar.trade_date) == (
        D0,
        D1,
        D2,
    )
    assert float(hit.first_volume_ratio) == pytest.approx(3.0)
    assert float(hit.second_volume_ratio) == pytest.approx(3.0)
    # 有 D2 当天简称快照 -> ST 判定是精确口径
    assert hit.st_basis is StBasis.D2_SNAPSHOT
    assert hit.st_exact is True


def test_hits_sorted_by_second_ratio(market: Container) -> None:
    result = market.screener_service.screen(D2)
    ratios = [float(hit.second_volume_ratio) for hit in result.hits]
    assert ratios == sorted(ratios, reverse=True)
    # 600001 的第二次量比为 9.0/3.0 = 3.0, 高于 600008 的 11.0/5.0 = 2.2
    assert result.hits[0].code == "sh.600001"


def test_funnel_is_monotonic(market: Container) -> None:
    funnel = market.screener_service.screen(D2).funnel
    assert funnel.universe == 8
    assert funnel.complete_data == 7
    assert funnel.listed_long_enough == 6
    assert funnel.pct_chg_in_range == 4
    assert funnel.volume_doubled == 3
    assert funnel.not_st == 2


def test_rejection_breakdown(market: Container) -> None:
    result = market.screener_service.screen(D2)
    # 未通过原因按"具体是哪条条件"归类 (模块化后每条条件各自计数)
    labels = result.rejection_counts
    assert labels[RejectionReason.INCOMPLETE_DATA.label] == 1
    assert labels["未通过: 上市满 3 个交易日"] == 1
    assert labels["未通过: T-2 至 T0（含首尾），每天涨跌幅均落在 (0%, +7%)"] == 2
    volume_labels = [
        count for label, count in labels.items() if "量比" in label
    ]
    assert sum(volume_labels) == 1
    assert labels["未通过: T0 为 ST / *ST 股票"] == 1


def test_st_stock_excluded_by_d2_name(market: Container) -> None:
    result = market.screener_service.screen(D2)
    assert "sh.600005" not in {hit.code for hit in result.hits}


def test_st_decided_by_name_snapshot_of_d2(market: Container) -> None:
    """把 D2 当天的简称改成 ST, 该股票应立即被剔除。"""

    with market.database.session() as conn:
        market.stock_repository.upsert_name_history(conn, [("sh.600001", D2, "*ST命中")])
    result = market.screener_service.screen(D2)
    assert "sh.600001" not in {hit.code for hit in result.hits}


def test_missing_day_data_raises(market: Container) -> None:
    with market.database.session() as conn:
        conn.execute("DELETE FROM synced_day WHERE trade_date = ?", (D1.isoformat(),))

    with pytest.raises(DataNotAvailableError) as excinfo:
        market.screener_service.screen(D2)
    assert excinfo.value.missing_dates == (D1,)
    assert excinfo.value.required_dates == (D0, D1, D2)


def test_no_result_returns_empty_tuple(container: Container) -> None:
    """没有任何股票时返回空结果而不是报错。"""

    seed(
        container,
        open_days=[PREV, D0, D1, D2],
        stocks=[make_stock("sh.600001", "普通股份", listing_date=date(2015, 1, 1))],
        bars=triple("sh.600001", volumes=(100, 100, 100), pcts=(1.0, 1.0, 1.0)),
        names={D2: [("sh.600001", "普通股份")]},
    )
    result = container.screener_service.screen(D2)
    assert result.hits == ()
    assert result.hit_count == 0


# --- 没有 D2 当天简称快照时的推断路径 ---------------------------------------


def build_service_with_history(
    container: Container, stub: StubNameHistory
) -> ScreenerService:
    """用替身的历史简称服务重建筛选服务。"""

    return ScreenerService(
        container.calendar_service,
        container.bar_repository,
        container.stock_repository,
        container.sync_repository,
        stub,  # type: ignore[arg-type]
    )


def seed_without_snapshot(container: Container, *, name: str = "命中股份") -> None:
    """只有行情, 没有 D2 简称快照。"""

    seed(
        container,
        open_days=[PREV, D0, D1, D2],
        stocks=[make_stock("sh.600001", name, listing_date=date(2015, 1, 1))],
        bars=triple(
            "sh.600001", volumes=(1_000_000, 3_000_000, 9_000_000), pcts=(1.0, 2.0, 3.0)
        ),
    )


def test_without_snapshot_uses_history(container: Container) -> None:
    seed_without_snapshot(container)
    stub = StubNameHistory({"sh.600001": ["G某某", "某某股份"]})
    result = build_service_with_history(container, stub).screen(D2)

    assert result.hit_count == 1
    hit = result.hits[0]
    assert hit.st_basis is StBasis.NAME_HISTORY
    assert hit.st_exact is True  # 历史简称里从未出现 ST -> 精确结论
    assert stub.calls == ["sh.600001"], "只对通过量价条件的候选股票取历史简称"
    assert any("简称快照" in warning for warning in result.warnings)


def test_without_snapshot_excludes_st_by_history(container: Container) -> None:
    seed_without_snapshot(container, name="ST某某")
    stub = StubNameHistory({"sh.600001": ["某某", "ST某某"]})
    result = build_service_with_history(container, stub).screen(D2)

    assert result.hit_count == 0
    assert result.rejection_counts["未通过: T0 为 ST / *ST 股票"] == 1
    assert result.funnel.not_st == 0


def test_without_snapshot_price_limit_refutes_st(container: Container) -> None:
    """D2 涨幅超过 ST 上限 -> 即使当前是 ST 也应保留, 且属于精确结论。"""

    seed(
        container,
        open_days=[PREV, D0, D1, D2],
        stocks=[make_stock("sh.600001", "ST某某", listing_date=date(2015, 1, 1))],
        bars=triple(
            "sh.600001", volumes=(1_000_000, 3_000_000, 9_000_000), pcts=(1.0, 2.0, 6.5)
        ),
    )
    stub = StubNameHistory({"sh.600001": ["某某", "ST某某"]})
    result = build_service_with_history(container, stub).screen(D2)

    assert result.hit_count == 1
    assert result.hits[0].st_basis is StBasis.PRICE_LIMIT
    assert result.hits[0].st_exact is True


def test_history_is_only_fetched_for_passing_candidates(container: Container) -> None:
    """量价条件不通过的股票不应触发历史简称抓取。"""

    seed(
        container,
        open_days=[PREV, D0, D1, D2],
        stocks=[
            make_stock("sh.600001", "命中", listing_date=date(2015, 1, 1)),
            make_stock("sh.600002", "不命中", listing_date=date(2015, 1, 1)),
        ],
        bars=triple(
            "sh.600001", volumes=(1_000_000, 3_000_000, 9_000_000), pcts=(1.0, 2.0, 3.0)
        )
        + triple(
            "sh.600002", volumes=(9_000_000, 1_000_000, 100_000), pcts=(8.0, -1.0, 0.0)
        ),
    )
    stub = StubNameHistory({"sh.600001": ["G命中", "命中"]})
    build_service_with_history(container, stub).screen(D2)
    assert stub.calls == ["sh.600001"]
