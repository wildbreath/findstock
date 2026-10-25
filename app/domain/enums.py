"""领域枚举。"""

from __future__ import annotations

from enum import Enum, IntEnum


class Exchange(str, Enum):
    """交易所。"""

    SH = "sh"
    SZ = "sz"


class Board(str, Enum):
    """板块 (仅保留沪深A股相关板块)。"""

    MAIN_SH = "main_sh"
    STAR = "star"
    MAIN_SZ = "main_sz"
    GEM = "gem"
    UNKNOWN = "unknown"

    @property
    def label(self) -> str:
        return {
            Board.MAIN_SH: "沪市主板",
            Board.STAR: "科创板",
            Board.MAIN_SZ: "深市主板",
            Board.GEM: "创业板",
            Board.UNKNOWN: "未知",
        }[self]


class TradeStatus(IntEnum):
    """交易日状态 (停牌 / 正常交易)。"""

    SUSPENDED = 0
    NORMAL = 1


class RejectionReason(str, Enum):
    """未通过筛选的原因 (按优先级取第一个命中的原因)。"""

    INCOMPLETE_DATA = "incomplete_data"
    NEWLY_LISTED = "newly_listed"
    PCT_CHG_OUT_OF_RANGE = "pct_chg_out_of_range"
    VOLUME_RATIO_TOO_LOW = "volume_ratio_too_low"
    ST_STOCK = "st_stock"

    @property
    def label(self) -> str:
        return _REJECTION_LABELS[self]


_REJECTION_LABELS: dict[RejectionReason, str] = {
    RejectionReason.INCOMPLETE_DATA: "三天数据缺失/停牌/字段无效",
    RejectionReason.NEWLY_LISTED: "上市时间不足 (少于三个交易日)",
    RejectionReason.PCT_CHG_OUT_OF_RANGE: "三日涨幅未全部落在 (0%, 7%)",
    RejectionReason.VOLUME_RATIO_TOO_LOW: "未连续两次成交量翻倍",
    RejectionReason.ST_STOCK: "D2 为 ST / *ST 股票",
}


class SyncMode(str, Enum):
    """数据同步模式。"""

    FULL = "full"
    INCREMENTAL = "incremental"
    TARGETED = "targeted"

    @property
    def label(self) -> str:
        return {
            SyncMode.FULL: "首次全量下载 (最近两年)",
            SyncMode.INCREMENTAL: "增量补充新增交易日",
            SyncMode.TARGETED: "按需补充指定日期",
        }[self]


class SyncStatus(str, Enum):
    """同步任务状态。"""

    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"


class StBasis(str, Enum):
    """ST 判定的依据 (历史日期往往拿不到当日简称, 需要如实标注口径)。"""

    D2_SNAPSHOT = "d2_snapshot"
    NAME_HISTORY = "name_history"
    PRICE_LIMIT = "price_limit"
    CURRENT_NAME = "current_name"

    @property
    def label(self) -> str:
        return {
            StBasis.D2_SNAPSHOT: "D2 当天简称 (精确)",
            StBasis.NAME_HISTORY: "历史简称序列 (推断)",
            StBasis.PRICE_LIMIT: "涨跌幅上限 (精确否决)",
            StBasis.CURRENT_NAME: "当前简称 (近似)",
        }[self]
