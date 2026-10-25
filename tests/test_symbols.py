"""股票代码范围与板块判定测试。"""

from __future__ import annotations

import pytest

from app.domain.enums import Board, Exchange
from app.domain.symbols import detect_board, is_a_share_code, split_code


@pytest.mark.parametrize(
    "code",
    [
        "sh.600000",
        "sh.601398",
        "sh.603259",
        "sh.605117",
        "sh.688981",
        "sz.000001",
        "sz.001979",
        "sz.002594",
        "sz.003816",
        "sz.300750",
        "sz.301717",
        "sz.302132",
    ],
)
def test_a_share_codes(code: str) -> None:
    assert is_a_share_code(code) is True


@pytest.mark.parametrize(
    "code",
    [
        "bj.430047",  # 北交所
        "bj.830799",  # 北交所
        "sh.000001",  # 上证指数
        "sz.399001",  # 深证成指
        "sh.510300",  # ETF
        "sz.159915",  # ETF
        "sh.113050",  # 可转债
        "sz.123456",  # 可转债
        "sh.900901",  # B股
        "sz.200011",  # B股
        "sh.688",  # 位数不足
        "invalid",
    ],
)
def test_non_a_share_codes(code: str) -> None:
    assert is_a_share_code(code) is False


@pytest.mark.parametrize(
    ("code", "board"),
    [
        ("sh.600000", Board.MAIN_SH),
        ("sh.688981", Board.STAR),
        ("sz.000001", Board.MAIN_SZ),
        ("sz.300750", Board.GEM),
    ],
)
def test_detect_board(code: str, board: Board) -> None:
    assert detect_board(code) is board


def test_split_code() -> None:
    assert split_code("sh.600000") == (Exchange.SH, "600000")
    assert split_code("sz.000001") == (Exchange.SZ, "000001")


@pytest.mark.parametrize("code", ["600000", "sh.60", "xx.600000", "sh.60000a"])
def test_split_code_rejects_invalid(code: str) -> None:
    with pytest.raises(ValueError):
        split_code(code)
