"""股票代码解析与沪深A股范围判定。"""

from __future__ import annotations

from app.domain.enums import Board, Exchange

#: 沪深A股代码前缀。刻意排除北交所(bj.*)、B股、ETF/基金、可转债与指数。
_A_SHARE_PREFIXES: dict[Exchange, frozenset[str]] = {
    Exchange.SH: frozenset({"60", "68"}),
    Exchange.SZ: frozenset({"00", "30"}),
}


def split_code(code: str) -> tuple[Exchange, str]:
    """拆分 ``sh.600000`` 形式的代码。"""

    if "." not in code:
        raise ValueError(f"非法股票代码: {code!r}")
    market, symbol = code.split(".", 1)
    try:
        exchange = Exchange(market)
    except ValueError as exc:
        raise ValueError(f"未知交易所: {market!r}") from exc
    if not symbol.isdigit() or len(symbol) != 6:
        raise ValueError(f"非法股票代码: {code!r}")
    return exchange, symbol


def format_code(exchange: Exchange, symbol: str) -> str:
    """组装标准代码。"""

    return f"{exchange.value}.{symbol}"


def is_a_share_code(code: str) -> bool:
    """是否为沪深A股 (排除北交所、B股、ETF/基金、可转债、指数)。"""

    try:
        exchange, symbol = split_code(code)
    except ValueError:
        return False
    prefixes = _A_SHARE_PREFIXES[exchange]
    return symbol[:2] in prefixes


def detect_board(code: str) -> Board:
    """由代码推断板块。"""

    try:
        exchange, symbol = split_code(code)
    except ValueError:
        return Board.UNKNOWN
    prefix = symbol[:2]
    if exchange is Exchange.SH:
        if prefix == "60":
            return Board.MAIN_SH
        if prefix == "68":
            return Board.STAR
    else:
        if prefix == "00":
            return Board.MAIN_SZ
        if prefix == "30":
            return Board.GEM
    return Board.UNKNOWN
