"""历史 ST 判定策略测试。"""

from __future__ import annotations

from decimal import Decimal

import pytest

from app.domain.enums import Board, StBasis
from app.domain.st_policy import decide_st, st_price_limit


def decide(**overrides):
    """按默认场景构造判定, 只覆盖需要的字段。"""

    params = {
        "board": Board.MAIN_SH,
        "name_at_d2": "浦发银行",
        "snapshot_available": True,
        "name_history": (),
        "current_name": "浦发银行",
        "pct_chg_at_d2": Decimal("1.0"),
    }
    params.update(overrides)
    return decide_st(**params)


class TestSnapshot:
    """有 D2 当天简称时必须是精确口径。"""

    def test_st_name_excluded(self) -> None:
        decision = decide(name_at_d2="*ST海航")
        assert decision.is_st is True
        assert decision.basis is StBasis.D2_SNAPSHOT
        assert decision.exact is True

    def test_normal_name_kept(self) -> None:
        decision = decide(name_at_d2="浦发银行")
        assert decision.is_st is False
        assert decision.exact is True

    def test_snapshot_wins_over_history(self) -> None:
        """即使历史上出现过 ST, 只要 D2 当天名称正常就应保留。"""

        decision = decide(
            name_at_d2="海泰发展",
            snapshot_available=True,
            name_history=("海泰发展", "ST海泰", "海泰发展"),
        )
        assert decision.is_st is False
        assert decision.basis is StBasis.D2_SNAPSHOT


class TestNameHistory:
    """拿不到当日简称时按历史简称序列推断。"""

    def test_never_st_is_exact(self) -> None:
        decision = decide(
            snapshot_available=False, name_history=("G浦发", "浦发银行")
        )
        assert decision.is_st is False
        assert decision.exact is True
        assert decision.basis is StBasis.NAME_HISTORY

    def test_currently_st_is_excluded(self) -> None:
        decision = decide(
            snapshot_available=False,
            name_history=("海泰发展", "ST海泰", "海泰发展", "ST海泰"),
            current_name="ST海泰",
            pct_chg_at_d2=Decimal("-1.2"),
        )
        assert decision.is_st is True
        assert decision.exact is False

    def test_renamed_back_is_kept(self) -> None:
        """出现过 ST 但当前已摘帽, 且没有证据表明 D2 当天是 ST -> 保留。"""

        decision = decide(
            snapshot_available=False,
            name_history=("ST某某", "某某股份"),
            current_name="某某股份",
            pct_chg_at_d2=Decimal("1.5"),
        )
        assert decision.is_st is False
        assert decision.exact is False

    def test_empty_history_falls_back_to_current_name(self) -> None:
        decision = decide(
            snapshot_available=False,
            name_history=(),
            current_name="ST某某",
            pct_chg_at_d2=Decimal("1.0"),
        )
        assert decision.is_st is True
        assert decision.basis is StBasis.CURRENT_NAME
        assert decision.exact is False


class TestPriceLimit:
    """涨跌幅超过 ST 上限时, 当天不可能是 ST —— 这是精确否决。"""

    @pytest.mark.parametrize("board", [Board.MAIN_SH, Board.MAIN_SZ])
    @pytest.mark.parametrize("pct", ["5.0001", "9.9", "-10.0"])
    def test_main_board_refuted(self, board: Board, pct: str) -> None:
        decision = decide(
            board=board,
            snapshot_available=False,
            name_history=("海泰发展", "ST海泰"),
            current_name="ST海泰",
            pct_chg_at_d2=Decimal(pct),
        )
        assert decision.is_st is False
        assert decision.basis is StBasis.PRICE_LIMIT
        assert decision.exact is True

    @pytest.mark.parametrize("pct", ["5.0", "4.9999", "-5.0"])
    def test_main_board_not_refuted_at_limit(self, pct: str) -> None:
        """正好等于上限不构成否决 (ST 可以恰好涨跌停)。"""

        decision = decide(
            snapshot_available=False,
            name_history=("海泰发展", "ST海泰"),
            current_name="ST海泰",
            pct_chg_at_d2=Decimal(pct),
        )
        assert decision.basis is StBasis.NAME_HISTORY
        assert decision.is_st is True

    @pytest.mark.parametrize("board", [Board.GEM, Board.STAR])
    def test_growth_board_uses_20_percent_limit(self, board: Board) -> None:
        below = decide(
            board=board,
            snapshot_available=False,
            name_history=("ST某某", "某某"),
            current_name="ST某某",
            pct_chg_at_d2=Decimal("15.0"),
        )
        above = decide(
            board=board,
            snapshot_available=False,
            name_history=("ST某某", "ST某某"),
            current_name="ST某某",
            pct_chg_at_d2=Decimal("20.5"),
        )
        assert below.basis is StBasis.NAME_HISTORY
        assert above.basis is StBasis.PRICE_LIMIT
        assert above.is_st is False

    def test_missing_pct_does_not_refute(self) -> None:
        decision = decide(
            snapshot_available=False,
            name_history=("ST某某", "ST某某"),
            current_name="ST某某",
            pct_chg_at_d2=None,
        )
        assert decision.basis is StBasis.NAME_HISTORY


@pytest.mark.parametrize(
    ("board", "expected"),
    [
        (Board.MAIN_SH, Decimal("5")),
        (Board.MAIN_SZ, Decimal("5")),
        (Board.GEM, Decimal("20")),
        (Board.STAR, Decimal("20")),
    ],
)
def test_st_price_limit(board: Board, expected: Decimal) -> None:
    assert st_price_limit(board) == expected
