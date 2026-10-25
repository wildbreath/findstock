"""筛选规则单元测试 —— 覆盖全部边界条件。"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest

from app.domain.enums import RejectionReason, TradeStatus
from app.domain.models import DailyBar, ScreenCandidate, ScreenCriteria, ScreenWindow, StockInfo
from app.domain.intervals import format_interval
from app.domain.rules import (
    compute_volume_ratio,
    evaluate_candidate,
    is_pct_chg_in_range,
    is_st_name,
    is_volume_doubled,
    rule_description,
)
from tests.factories import make_bar, make_stock

D0 = date(2026, 9, 14)
D1 = date(2026, 9, 15)
D2 = date(2026, 9, 16)
PREV = date(2026, 9, 11)

WINDOW = ScreenWindow(
    selected_date=D2, d0=D0, d1=D1, d2=D2, previous_trading_day=PREV
)


def test_interval_never_includes_infinity() -> None:
    assert format_interval(Decimal("2"), None, True) == "[2, +∞)"
    assert format_interval(None, Decimal("3"), True) == "(-∞, 3]"
    assert format_interval(None, None, True) == "(-∞, +∞)"


def candidate(
    *,
    d0: DailyBar | None,
    d1: DailyBar | None,
    d2: DailyBar | None,
    name: str = "测试股份",
    listing_date: date | None = date(2020, 1, 1),
) -> ScreenCandidate:
    """构造候选股票。"""

    bars = {
        bar.trade_date: bar for bar in (d0, d1, d2) if bar is not None
    }
    stock: StockInfo = make_stock("sh.600000", name, listing_date=listing_date)
    return ScreenCandidate(stock=stock, name_at_d2=name, bars=bars)


def happy_path(**overrides) -> ScreenCandidate:
    """构造一只完全符合条件的股票。"""

    params = {
        "d0": make_bar("sh.600000", D0, pct_chg=1.5, volume=1_000_000),
        "d1": make_bar("sh.600000", D1, pct_chg=2.5, volume=3_000_000),
        "d2": make_bar("sh.600000", D2, pct_chg=3.5, volume=9_000_000),
    }
    params.update(overrides)
    return candidate(**params)


class TestVolumeDoubling:
    """成交量翻倍必须是严格大于 2 倍。"""

    @pytest.mark.parametrize(
        ("current", "previous", "expected"),
        [
            (2_000_000, 1_000_000, False),  # 正好 2 倍 -> 不符合
            (2_000_001, 1_000_000, True),  # 刚过 2 倍 -> 符合
            (1_999_999, 1_000_000, False),
            (0, 1_000_000, False),
            (1_000_000, 0, False),
            (None, 1_000_000, False),
            (1_000_000, None, False),
        ],
    )
    def test_is_volume_doubled(self, current, previous, expected) -> None:
        assert is_volume_doubled(current, previous) is expected

    def test_exactly_two_times_is_rejected(self) -> None:
        result = evaluate_candidate(
            happy_path(
                d0=make_bar("sh.600000", D0, pct_chg=1.5, volume=1_000_000),
                d1=make_bar("sh.600000", D1, pct_chg=2.5, volume=2_000_000),
                d2=make_bar("sh.600000", D2, pct_chg=3.5, volume=4_000_000),
            ),
            WINDOW,
        )
        assert result.reason is RejectionReason.VOLUME_RATIO_TOO_LOW
        assert result.first_volume_ratio == Decimal("2.0000")

    def test_second_ratio_failure_is_detected(self) -> None:
        result = evaluate_candidate(
            happy_path(
                d1=make_bar("sh.600000", D1, pct_chg=2.5, volume=3_000_000),
                d2=make_bar("sh.600000", D2, pct_chg=3.5, volume=6_000_000),
            ),
            WINDOW,
        )
        assert result.reason is RejectionReason.VOLUME_RATIO_TOO_LOW

    def test_compute_volume_ratio_rounds_to_four_decimals(self) -> None:
        assert compute_volume_ratio(10_000_000, 3_000_000) == Decimal("3.3333")


class TestPctChgRange:
    """涨幅区间为 (0%, 7%) 开区间。"""

    @pytest.mark.parametrize(
        ("value", "expected"),
        [
            ("0", False),
            ("0.0000", False),
            ("-0.0001", False),
            ("0.0001", True),
            ("6.9999", True),
            ("7", False),
            ("7.0000", False),
            ("7.0001", False),
            (None, False),
        ],
    )
    def test_is_pct_chg_in_range(self, value, expected) -> None:
        parsed = None if value is None else Decimal(value)
        assert is_pct_chg_in_range(parsed) is expected

    @pytest.mark.parametrize("bad_day", ["d0", "d1", "d2"])
    @pytest.mark.parametrize("bad_value", ["0", "7"])
    def test_any_day_out_of_range_rejects(self, bad_day, bad_value) -> None:
        kwargs = {
            "d0": make_bar("sh.600000", D0, pct_chg=1.5, volume=1_000_000),
            "d1": make_bar("sh.600000", D1, pct_chg=2.5, volume=3_000_000),
            "d2": make_bar("sh.600000", D2, pct_chg=3.5, volume=9_000_000),
        }
        kwargs[bad_day] = make_bar(
            "sh.600000",
            {"d0": D0, "d1": D1, "d2": D2}[bad_day],
            pct_chg=bad_value,
            volume={"d0": 1_000_000, "d1": 3_000_000, "d2": 9_000_000}[bad_day],
        )
        result = evaluate_candidate(happy_path(**kwargs), WINDOW)
        assert result.reason is RejectionReason.PCT_CHG_OUT_OF_RANGE
        assert result.pct_chg_in_range is False


class TestStNameRecognition:
    """简称里的 ST 标记识别 (供 ST 策略复用)。"""

    @pytest.mark.parametrize(
        ("name", "expected"),
        [
            ("ST九鼎", True),
            ("*ST九鼎", True),
            ("st九鼎", True),
            ("＊ＳＴ九鼎", True),  # 全角星号 + 全角字母
            ("S T 九鼎", False),
            ("浦发银行", False),
            ("TCL科技", False),
            ("*ST 海航", True),
            ("", False),
            (None, False),
        ],
    )
    def test_is_st_name(self, name, expected) -> None:
        assert is_st_name(name) is expected


class TestCompleteness:
    """数据完整性校验。"""

    def test_missing_d1_bar(self) -> None:
        result = evaluate_candidate(happy_path(d1=None), WINDOW)
        assert result.reason is RejectionReason.INCOMPLETE_DATA
        assert "T-1" in result.detail

    def test_suspended_day_is_incomplete(self) -> None:
        result = evaluate_candidate(
            happy_path(
                d1=make_bar(
                    "sh.600000",
                    D1,
                    pct_chg=None,
                    volume=None,
                    close=None,
                    trade_status=TradeStatus.SUSPENDED,
                )
            ),
            WINDOW,
        )
        assert result.reason is RejectionReason.INCOMPLETE_DATA

    def test_zero_volume_is_incomplete(self) -> None:
        result = evaluate_candidate(
            happy_path(d2=make_bar("sh.600000", D2, pct_chg=3.5, volume=0)), WINDOW
        )
        assert result.reason is RejectionReason.INCOMPLETE_DATA

    def test_unknown_trade_status_is_treated_as_normal(self) -> None:
        """数据源不提供交易状态时不能误判为停牌 (akshare 就是这种情况)。"""

        result = evaluate_candidate(
            happy_path(
                d0=make_bar("sh.600000", D0, pct_chg=1.5, volume=1_000_000, trade_status=None)
            ),
            WINDOW,
        )
        assert result.complete_data is True


class TestListingAge:
    """上市时间不足三个交易日的股票必须排除。"""

    def test_listed_on_d0_is_rejected(self) -> None:
        result = evaluate_candidate(happy_path(listing_date=D0), WINDOW)
        assert result.reason is RejectionReason.NEWLY_LISTED

    def test_listed_long_ago_passes_listing_check(self) -> None:
        result = evaluate_candidate(happy_path(listing_date=date(2010, 5, 6)), WINDOW)
        assert result.passed is True

    def test_listed_exactly_on_previous_trading_day_passes(self) -> None:
        result = evaluate_candidate(happy_path(listing_date=PREV), WINDOW)
        assert result.passed is True


class TestReasonPriority:
    """未通过原因按固定优先级取第一个 (ST 判定不在本层, 见 test_st_policy)。"""

    def test_incomplete_data_beats_newly_listed(self) -> None:
        result = evaluate_candidate(happy_path(d0=None, listing_date=D0), WINDOW)
        assert result.reason is RejectionReason.INCOMPLETE_DATA

    def test_pct_range_beats_volume(self) -> None:
        result = evaluate_candidate(
            happy_path(d0=make_bar("sh.600000", D0, pct_chg=8.0, volume=1_000_000)),
            WINDOW,
        )
        assert result.reason is RejectionReason.PCT_CHG_OUT_OF_RANGE

    def test_volume_ratio_is_last(self) -> None:
        result = evaluate_candidate(
            happy_path(d1=make_bar("sh.600000", D1, pct_chg=2.5, volume=1_500_000)),
            WINDOW,
        )
        assert result.reason is RejectionReason.VOLUME_RATIO_TOO_LOW


def test_happy_path_passes() -> None:
    """完全符合条件的股票必须通过。"""

    result = evaluate_candidate(happy_path(), WINDOW)
    assert result.passed is True
    assert result.reason is None
    assert result.first_volume_ratio == Decimal("3.0000")
    assert result.second_volume_ratio == Decimal("3.0000")


class TestCustomCriteria:
    """阈值可调: 同一只股票在不同参数下应当得到不同结论。"""

    def test_custom_volume_threshold_is_strict(self) -> None:
        assert is_volume_doubled(300, 100, Decimal("3")) is False
        assert is_volume_doubled(301, 100, Decimal("3")) is True
        assert is_volume_doubled(150, 100, Decimal("1.5")) is False
        assert is_volume_doubled(151, 100, Decimal("1.5")) is True

    def test_looser_ratios_accept_previously_rejected_stock(self) -> None:
        candidate = happy_path(
            d0=make_bar("sh.600000", D0, pct_chg=1.5, volume=1_000_000),
            d1=make_bar("sh.600000", D1, pct_chg=2.5, volume=1_200_000),
            d2=make_bar("sh.600000", D2, pct_chg=3.5, volume=1_500_000),
        )
        assert evaluate_candidate(candidate, WINDOW).passed is False

        relaxed = ScreenCriteria(
            first_volume_ratio_min=Decimal("1.1"),
            second_volume_ratio_min=Decimal("1.1"),
        )
        assert evaluate_candidate(candidate, WINDOW, relaxed).passed is True

    def test_custom_pct_range_is_applied(self) -> None:
        narrowed = ScreenCriteria(
            pct_chg_min=Decimal("1"), pct_chg_max=Decimal("3")
        )
        result = evaluate_candidate(happy_path(), WINDOW, narrowed)
        assert result.reason is RejectionReason.PCT_CHG_OUT_OF_RANGE
        assert "(+1%, +3%)" in result.detail

    def test_negative_lower_bound_allows_falling_days(self) -> None:
        candidate = happy_path(
            d0=make_bar("sh.600000", D0, pct_chg=-2.0, volume=1_000_000)
        )
        assert evaluate_candidate(candidate, WINDOW).passed is False

        wider = ScreenCriteria(
            pct_chg_min=Decimal("-5"), pct_chg_max=Decimal("7")
        )
        assert evaluate_candidate(candidate, WINDOW, wider).passed is True

    def test_newly_listed_can_be_kept(self) -> None:
        candidate = happy_path(listing_date=D0)
        assert evaluate_candidate(candidate, WINDOW).passed is False

        keep_new = ScreenCriteria(exclude_newly_listed=False)
        result = evaluate_candidate(candidate, WINDOW, keep_new)
        assert result.passed is True
        assert result.listed_long_enough is True

    def test_invalid_criteria_is_rejected(self) -> None:
        with pytest.raises(ValueError):
            ScreenCriteria(pct_chg_min=Decimal("8"), pct_chg_max=Decimal("7"))
        with pytest.raises(ValueError):
            ScreenCriteria(first_volume_ratio_min=Decimal("-1"))

    def test_rule_description_follows_criteria(self) -> None:
        described = rule_description(
            ScreenCriteria(
                first_volume_ratio_min=Decimal("1.5"),
                pct_chg_max=Decimal("9.5"),
                exclude_st=False,
            )
        )
        assert "(1.5 倍, +∞)" in described["volume_ratio"]
        assert "9.5%" in described["pct_chg"]
        assert described["st"] == "不排除 ST / *ST 股票"

    def test_volume_ratio_upper_bound_is_enforced(self) -> None:
        """量比区间也要有上限: 放量过猛的股票可以被排除。"""

        candidate = happy_path(
            d0=make_bar("sh.600000", D0, pct_chg=1.5, volume=1_000_000),
            d1=make_bar("sh.600000", D1, pct_chg=2.5, volume=5_000_000),
            d2=make_bar("sh.600000", D2, pct_chg=3.5, volume=30_000_000),
        )
        assert evaluate_candidate(candidate, WINDOW).passed is True

        capped = ScreenCriteria(
            second_volume_ratio_min=Decimal("2"),
            second_volume_ratio_max=Decimal("6"),
        )
        result = evaluate_candidate(candidate, WINDOW, capped)
        assert result.reason is RejectionReason.VOLUME_RATIO_TOO_LOW
        assert "(2 倍, 6 倍)" in result.detail

    def test_inclusive_flag_controls_boundary(self) -> None:
        """含边界时 2 倍与 7% 都能通过, 不含边界时必须严格越界。"""

        on_boundary = happy_path(
            d0=make_bar("sh.600000", D0, pct_chg=0.0, volume=1_000_000),
            d1=make_bar("sh.600000", D1, pct_chg=2.0, volume=2_000_000),
            d2=make_bar("sh.600000", D2, pct_chg=7.0, volume=8_000_000),
        )
        assert evaluate_candidate(on_boundary, WINDOW).passed is False

        inclusive = ScreenCriteria(
            pct_chg_inclusive=True,
            first_volume_ratio_inclusive=True,
            second_volume_ratio_inclusive=True,
        )
        assert evaluate_candidate(on_boundary, WINDOW, inclusive).passed is True

    def test_negative_range_allows_pullback_days(self) -> None:
        """区间可以写成负到正 (例如 -3% ~ +5%), 允许回调日。"""

        candidate = happy_path(
            d0=make_bar("sh.600000", D0, pct_chg=-2.5, volume=1_000_000),
            d1=make_bar("sh.600000", D1, pct_chg=1.0, volume=3_000_000),
        )
        assert evaluate_candidate(candidate, WINDOW).passed is False

        swing = ScreenCriteria(
            pct_chg_min=Decimal("-3"), pct_chg_max=Decimal("5")
        )
        result = evaluate_candidate(candidate, WINDOW, swing)
        assert result.passed is True
        assert "(-3%, +5%)" in rule_description(swing)["pct_chg"]

    def test_one_sided_interval_disables_that_side(self) -> None:
        """只设上限 (不限下限) 也应生效。"""

        capped = ScreenCriteria(pct_chg_min=None, pct_chg_max=Decimal("3"))
        candidate = happy_path(
            d0=make_bar("sh.600000", D0, pct_chg=-9.0, volume=1_000_000),
            d2=make_bar("sh.600000", D2, pct_chg=2.0, volume=9_000_000),
        )
        assert evaluate_candidate(candidate, WINDOW, capped).passed is True

        too_high = happy_path(
            d0=make_bar("sh.600000", D0, pct_chg=4.0, volume=1_000_000)
        )
        assert evaluate_candidate(too_high, WINDOW, capped).passed is False
