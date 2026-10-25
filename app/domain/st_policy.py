"""历史 ST 判定策略。

需求要求 "尽量按照所选历史日期当天的 ST 状态判断, 不能只使用股票现在的名称"。
akshare 能提供的数据只有两种:

1. **当日简称快照** —— ``stock_zh_a_spot`` 取到的当天简称。当被筛选的 D2
   正好是取数那天时, 这是**精确**的历史口径。
2. **历史简称序列** (``stock_info_change_name``) —— 由旧到新的顺序列表,
   **不含日期**, 因此无法直接定位 D2。

对于拿不到当日快照的历史日期, 本模块用三条证据推断:

* 序列里从未出现过 ST: 说明该股票从未被 ST, **精确**判否;
* D2 当天涨跌幅超过该板块 ST 的涨跌幅上限: 主板 ST 为 ±5%、创业板/科创板
  为 ±20%, 超过上限的那一天**不可能**是 ST, **精确**判否;
* 否则看序列的最后一个名字 (即当前简称): 仍是 ST 就判为 ST (保守),
  已摘帽就判为非 ST。

每次判定都会带上依据 (:class:`StBasis`), 结果页会据此提示哪些命中的
ST 判定不是精确口径, 便于人工复核。
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from decimal import Decimal

from app.domain.enums import Board, StBasis
from app.domain.rules import is_st_name

#: ST 股票在各板块的涨跌幅上限 (%)
_ST_PRICE_LIMITS: dict[Board, Decimal] = {
    Board.MAIN_SH: Decimal("5"),
    Board.MAIN_SZ: Decimal("5"),
    Board.GEM: Decimal("20"),
    Board.STAR: Decimal("20"),
    Board.UNKNOWN: Decimal("5"),
}


def st_price_limit(board: Board) -> Decimal:
    """返回该板块 ST 股票的涨跌幅上限。"""

    return _ST_PRICE_LIMITS.get(board, Decimal("5"))


@dataclass(frozen=True, slots=True)
class StDecision:
    """单只股票在 D2 的 ST 判定结果。"""

    is_st: bool
    basis: StBasis
    detail: str
    #: 是否为精确口径。"从未出现 ST" 与 "涨跌幅超上限" 同样是精确结论,
    #: 只有 "按当前简称推断" 才是近似。
    exact: bool = True


def decide_st(
    *,
    board: Board,
    name_at_d2: str | None,
    snapshot_available: bool,
    name_history: Sequence[str],
    current_name: str | None,
    pct_chg_at_d2: Decimal | None,
) -> StDecision:
    """判定 D2 当天该股票是否属于 ST/*ST。"""

    # 1) 有 D2 当天的简称 -> 精确
    if snapshot_available:
        is_st = is_st_name(name_at_d2)
        return StDecision(
            is_st=is_st,
            basis=StBasis.D2_SNAPSHOT,
            detail=f"D2 简称为 {name_at_d2!r}",
        )

    limit = st_price_limit(board)
    refuted = pct_chg_at_d2 is not None and abs(pct_chg_at_d2) > limit

    # 2) 历史简称序列里从未出现 ST -> 精确判否
    if name_history and not any(is_st_name(name) for name in name_history):
        return StDecision(
            is_st=False,
            basis=StBasis.NAME_HISTORY,
            detail="历史简称中从未出现 ST",
        )

    # 3) D2 超出 ST 涨跌幅上限 -> 精确判否
    if refuted:
        return StDecision(
            is_st=False,
            basis=StBasis.PRICE_LIMIT,
            detail=(
                f"D2 涨幅 {pct_chg_at_d2}% 超过 ST 涨跌幅上限 {limit}%, "
                "当天不可能是 ST"
            ),
        )

    # 4) 用当前简称推断
    if name_history:
        latest = name_history[-1]
        if is_st_name(latest):
            return StDecision(
                is_st=True,
                basis=StBasis.NAME_HISTORY,
                detail=f"当前简称 {latest!r} 仍为 ST, 且无证据表明 D2 当天不是 ST",
                exact=False,
            )
        return StDecision(
            is_st=False,
            basis=StBasis.NAME_HISTORY,
            detail=f"当前简称 {latest!r} 已摘帽, 且无证据表明 D2 当天是 ST",
            exact=False,
        )

    return StDecision(
        is_st=is_st_name(current_name),
        basis=StBasis.CURRENT_NAME,
        detail=f"缺少历史简称数据, 退化使用当前简称 {current_name!r}",
        exact=False,
    )
