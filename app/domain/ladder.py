"""涨停股池快照; 连板数直接使用数据源口径。"""

from dataclasses import dataclass
from datetime import date, datetime
from typing import Literal


@dataclass(frozen=True, slots=True)
class LimitUpStock:
    code: str
    name: str
    consecutive: int
    price: float | None
    pct_chg: float | None
    amount: float | None
    turnover: float | None
    seal_funds: float | None
    first_seal: str | None
    last_seal: str | None
    breaks: int | None
    industry: str
    board: str
    board_label: str
    is_st: bool
    primary_theme: str | None = None


@dataclass(frozen=True, slots=True)
class LadderSnapshot:
    trade_date: date
    trading_days: list[date]
    fetched_at: datetime
    items: list[LimitUpStock]
    data_source: Literal["eastmoney", "ths", "local"] = "eastmoney"
    is_final: bool = False
    stale: bool = False
    origin: Literal["eastmoney", "ths"] = "eastmoney"
    theme_fetched_at: datetime | None = None
    theme_complete: bool = False
    theme_is_final: bool = False
    theme_error: str | None = None


@dataclass(frozen=True, slots=True)
class LadderSectorCandidates:
    trading_days: list[date]
    covered_dates: list[date]
    codes: list[str]


@dataclass(frozen=True, slots=True)
class ThemeCandidate:
    name: str
    stock_count: int


@dataclass(frozen=True, slots=True)
class LadderThemeCandidates:
    trading_days: list[date]
    covered_dates: list[date]
    classified_dates: list[date]
    themes: list[ThemeCandidate]
    unclassified_count: int
    trade_date: date
