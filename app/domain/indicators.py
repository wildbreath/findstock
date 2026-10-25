"""技术指标计算 (纯函数, 无 I/O)。"""

from __future__ import annotations

from collections.abc import Sequence
from decimal import ROUND_HALF_UP, Decimal

#: K 线图默认展示的均线周期。
DEFAULT_MA_WINDOWS: tuple[int, ...] = (5, 10, 20, 60)

_MA_QUANTUM = Decimal("0.0001")


def moving_average(
    values: Sequence[Decimal | None], window: int
) -> list[Decimal | None]:
    """简单移动平均 (SMA)。

    返回与输入等长的列表: 数据不足 ``window`` 根的位置为 ``None``。
    窗口内一旦出现缺口 (None), 该点也返回 ``None``, 避免用不完整数据画出
    误导性的均线。
    """

    if window <= 0:
        raise ValueError("均线窗口必须为正整数")

    result: list[Decimal | None] = []
    for index in range(len(values)):
        if index + 1 < window:
            result.append(None)
            continue
        window_values = values[index + 1 - window : index + 1]
        if any(value is None for value in window_values):
            result.append(None)
            continue
        total = sum((value for value in window_values if value is not None), Decimal(0))
        result.append((total / window).quantize(_MA_QUANTUM, rounding=ROUND_HALF_UP))
    return result


def moving_averages(
    values: Sequence[Decimal | None], windows: Sequence[int] = DEFAULT_MA_WINDOWS
) -> dict[int, list[Decimal | None]]:
    """一次算出多条均线, 键为周期。"""

    return {window: moving_average(values, window) for window in windows}
