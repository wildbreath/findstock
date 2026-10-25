"""数值区间原语: 区间判定、量比计算与区间文本。

这里只依赖 :mod:`decimal`, 是 :mod:`app.domain.rules` 与
:mod:`app.domain.conditions` 共同的下层依赖 —— 有了它, 规则层与条件层
互不依赖, 不会再出现模块级循环导入。
"""

from __future__ import annotations

from decimal import ROUND_HALF_UP, Decimal

#: 展示量比时保留的小数位。
RATIO_QUANTUM = Decimal("0.0001")


def to_decimal(value: Decimal | int | float | str) -> Decimal:
    """把整数/浮点/字符串统一转成 Decimal (浮点走 str, 避免二进制误差)。"""

    if isinstance(value, Decimal):
        return value
    return Decimal(str(value))


def value_in_interval(
    value: Decimal | None,
    low: Decimal | None,
    high: Decimal | None,
    inclusive: bool,
) -> bool:
    """值是否落在区间内; 任一侧为 None 表示该方向不限制。

    ``inclusive=False`` 时按严格不等式判断 (大于下限、小于上限), 与默认规则一致。
    """

    if value is None:
        return False
    if low is not None:
        if inclusive:
            if value < low:
                return False
        elif value <= low:
            return False
    if high is not None:
        if inclusive:
            if value > high:
                return False
        elif value >= high:
            return False
    return True


def volume_ratio_in_interval(
    current_volume: int | None,
    previous_volume: int | None,
    low: Decimal | None,
    high: Decimal | None,
    inclusive: bool,
) -> bool:
    """成交量比值 (当前 / 前一交易日) 是否落在区间内。

    比较用整数 × 阈值乘法完成, 不做除法, 因此不存在浮点或精度误差。
    """

    if current_volume is None or previous_volume is None:
        return False
    if current_volume <= 0 or previous_volume <= 0:
        return False
    if low is None and high is None:
        return True
    current = Decimal(current_volume)
    previous = Decimal(previous_volume)
    for bound, is_low in ((low, True), (high, False)):
        if bound is None:
            continue
        boundary = to_decimal(bound) * previous
        if is_low:
            if inclusive:
                if current < boundary:
                    return False
            elif current <= boundary:
                return False
        else:
            if inclusive:
                if current > boundary:
                    return False
            elif current >= boundary:
                return False
    return True


def compute_volume_ratio(current_volume: int, previous_volume: int) -> Decimal:
    """计算量比 (当前成交量 / 前一交易日成交量), 用于展示。"""

    if previous_volume <= 0:
        raise ValueError("前一交易日成交量必须大于 0")
    return (Decimal(current_volume) / Decimal(previous_volume)).quantize(
        RATIO_QUANTUM, rounding=ROUND_HALF_UP
    )


def format_number(value: Decimal) -> str:
    """把阈值格式化成紧凑的展示形式 (2.0 -> 2, 2.5 -> 2.5)。"""

    return format(value.normalize(), "f")


def format_interval(
    low: Decimal | None,
    high: Decimal | None,
    inclusive: bool,
    *,
    unit: str = "",
    signed: bool = False,
) -> str:
    """把区间格式化成 ``[-5%, +9%]`` / ``(2, +∞)`` 这样的展示文本。"""

    def bound(value: Decimal) -> str:
        if signed and value > 0:
            return f"+{format_number(value)}{unit}"
        return f"{format_number(value)}{unit}"

    left = "[" if inclusive and low is not None else "("
    right = "]" if inclusive and high is not None else ")"
    low_text = "-∞" if low is None else bound(low)
    high_text = "+∞" if high is None else bound(high)
    return f"{left}{low_text}, {high_text}{right}"
