"""个股 K 线与自选股查询服务。"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from decimal import Decimal

from app.core.errors import InvalidRequestError
from app.domain.indicators import DEFAULT_MA_WINDOWS, moving_averages
from app.domain.models import DailyBar, StockInfo
from app.domain.symbols import detect_board, split_code
from app.repositories.bar_repository import BarRepository
from app.repositories.stock_repository import StockRepository
from app.repositories.watchlist_repository import (
    WatchlistCategory,
    WatchlistItem,
    WatchlistRepository,
)

#: 单次最多返回多少根 K 线 (前端还要额外的均线预热数据)。
MAX_CHART_BARS = 400


@dataclass(frozen=True, slots=True)
class StockChart:
    """K 线图数据。"""

    code: str
    name: str
    board: str
    bars: tuple[DailyBar, ...]
    ma_windows: tuple[int, ...]
    #: 与 bars 等长, 每项是 {周期: 值} (值可能为 None)。
    ma_values: tuple[dict[int, Decimal | None], ...]


@dataclass(frozen=True, slots=True)
class WatchlistEntry:
    """自选股 + 本地最新行情。"""

    item: WatchlistItem
    name: str
    board: str
    latest: DailyBar | None


class StockChartService:
    """按股票代码取 K 线 / 均线, 以及自选股列表。"""

    def __init__(
        self,
        bar_repository: BarRepository,
        stock_repository: StockRepository,
        watchlist_repository: WatchlistRepository,
    ) -> None:
        self._bars = bar_repository
        self._stocks = stock_repository
        self._watchlist = watchlist_repository

    # --- K 线 -------------------------------------------------------------

    def chart(
        self,
        code: str,
        *,
        end: date | None = None,
        limit: int = 180,
        ma_windows: tuple[int, ...] = DEFAULT_MA_WINDOWS,
    ) -> StockChart:
        """取 K 线数据; 多取一段数据用于均线预热, 但只返回最后 limit 根。

        返回的均线在截取窗口的最左端也是有效的 (因为预热数据参与了计算)。
        """

        window = max(1, min(limit, MAX_CHART_BARS))
        warmup = max(ma_windows, default=0)
        bars = self._bars.load_recent_bars(
            code, end=end, limit=window + max(0, warmup - 1)
        )

        closes = [bar.close for bar in bars]
        series = moving_averages(closes, ma_windows)
        values = [
            {period: series[period][index] for period in ma_windows}
            for index in range(len(bars))
        ]

        keep = bars[-window:] if len(bars) > window else bars
        offset = len(bars) - len(keep)
        stock = self._stock_info(code)
        return StockChart(
            code=code,
            name=self._display_name(code, stock),
            board=stock.board.value,
            bars=tuple(keep),
            ma_windows=tuple(ma_windows),
            ma_values=tuple(values[offset:]),
        )

    # --- 自选股 -----------------------------------------------------------

    def watchlist(self) -> list[WatchlistEntry]:
        """自选股列表, 附上本地最新的一根日线 (没有行情时为 None)。"""

        items = self._watchlist.list_all()
        latest = self._bars.latest_bars([item.code for item in items])
        memberships = self._watchlist.categories_by_code()
        entries: list[WatchlistEntry] = []
        for item in items:
            stock = self._stock_info(item.code)
            entries.append(
                WatchlistEntry(
                    item=WatchlistItem(
                        code=item.code,
                        name=item.name,
                        board=item.board,
                        source_date=item.source_date,
                        note=item.note,
                        note_highlights=item.note_highlights,
                        added_at=item.added_at,
                        category_ids=tuple(memberships.get(item.code, ())),
                    ),
                    name=item.name or self._display_name(item.code, stock),
                    board=item.board or stock.board.value,
                    latest=latest.get(item.code),
                )
            )
        return entries

    def categories(self) -> list[WatchlistCategory]:
        """全部分类 (含每个分类的股票数量)。"""

        return self._watchlist.list_categories()

    def create_category(self, name: str) -> WatchlistCategory:
        return self._watchlist.create_category(name)

    def delete_category(self, category_id: int) -> bool:
        return self._watchlist.delete_category(category_id)

    def update_note(
        self, code: str, note: str | None, *, note_highlights: list[tuple[int, int]] | None = None,
        category_ids: list[int] | None = None,
    ) -> bool:
        """更新自选股备注 (空字符串按"清空"处理)。"""

        cleaned = None if note is None else note.strip()
        ranges: list[tuple[int, int]] = []
        for start, end in sorted(note_highlights or []):
            if not 0 <= start < end <= len(cleaned or ""):
                raise InvalidRequestError("备注高亮区间超出文字范围。")
            if ranges and start <= ranges[-1][1]:
                ranges[-1] = (ranges[-1][0], max(ranges[-1][1], end))
            else:
                ranges.append((start, end))
        return self._watchlist.update_note(
            code, cleaned or None, note_highlights=tuple(ranges), category_ids=category_ids
        )

    def reorder_watchlist(self, codes: list[str]) -> list[str]:
        return self._watchlist.reorder(codes)

    def set_categories(self, code: str, category_ids: list[int]) -> None:
        """整体替换某只自选股的分类。"""

        self._watchlist.set_categories(code, category_ids)

    def add_to_watchlist(
        self,
        code: str,
        *,
        name: str | None = None,
        source_date: date | None = None,
        note: str | None = None,
        category_ids: list[int] | None = None,
    ) -> WatchlistItem:
        stock = self._stock_info(code)
        return self._watchlist.add(
            WatchlistItem(
                code=code,
                name=name or stock.name,
                board=stock.board.value,
                source_date=source_date,
                note=note,
            ),
            category_ids=category_ids,
        )

    def remove_from_watchlist(self, code: str) -> bool:
        return self._watchlist.remove(code)

    def add_many_to_watchlist(
        self, stocks: list[tuple[str, str | None]], *, source_date: date,
        category_ids: list[int], replace_categories: bool = False,
    ) -> None:
        if len({code for code, _ in stocks}) != len(stocks):
            raise InvalidRequestError("同一批股票代码不能重复。")
        items = []
        for code, name in stocks:
            stock = self._stock_info(code)
            items.append(WatchlistItem(
                code=code, name=name or stock.name, board=stock.board.value,
                source_date=source_date,
            ))
        self._watchlist.add_many(
            items, category_ids=category_ids, replace_categories=replace_categories,
        )

    def watchlist_codes(self) -> set[str]:
        return self._watchlist.codes()

    # --- 内部 -------------------------------------------------------------

    def _stock_info(self, code: str) -> StockInfo:
        stock = self._stocks.get(code)
        if stock is not None:
            return stock
        exchange, symbol = split_code(code)
        return StockInfo(
            code=code,
            exchange=exchange,
            symbol=symbol,
            name=None,
            board=detect_board(code),
        )

    def _display_name(self, code: str, stock: StockInfo) -> str:
        """股票简称: 优先取基础信息表, 缺失时退化为代码。"""

        return stock.name or code
