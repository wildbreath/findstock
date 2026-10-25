"""领域异常。API 层将其映射为结构化错误响应。"""

from __future__ import annotations

from datetime import date


class FindStockError(Exception):
    """所有业务异常的基类。"""

    code = "internal_error"

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


class CalendarNotInitializedError(FindStockError):
    """交易日历尚未下载。"""

    code = "calendar_not_initialized"


class NotATradingDayError(FindStockError):
    """用户选择的日期不是交易日。"""

    code = "not_a_trading_day"

    def __init__(self, message: str, *, selected_date: date, suggested_date: date | None) -> None:
        super().__init__(message)
        self.selected_date = selected_date
        self.suggested_date = suggested_date


class InsufficientHistoryError(FindStockError):
    """所选日期之前没有足够的交易日。"""

    code = "insufficient_history"

    def __init__(self, message: str, *, selected_date: date, available_before: int) -> None:
        super().__init__(message)
        self.selected_date = selected_date
        self.available_before = available_before


class DataNotAvailableError(FindStockError):
    """所需交易日的数据不在本地。"""

    code = "data_not_available"

    def __init__(
        self,
        message: str,
        *,
        missing_dates: tuple[date, ...] = (),
        required_dates: tuple[date, ...] = (),
        suggested_date: date | None = None,
    ) -> None:
        super().__init__(message)
        self.missing_dates = missing_dates
        #: 为完成本次筛选需要补齐的完整交易日集合 (供前端一键补数)。
        self.required_dates = required_dates
        self.suggested_date = suggested_date


class SyncAlreadyRunningError(FindStockError):
    """已有同步任务在运行。"""

    code = "sync_already_running"


class StockNotFoundError(FindStockError):
    """本地没有这只股票的行情数据。"""

    code = "stock_not_found"


class InvalidRequestError(FindStockError):
    """请求语义不合法 (参数本身可解析, 但不满足业务要求)。"""

    code = "invalid_request"


class ProviderError(FindStockError):
    """数据源返回错误或不可用。"""

    code = "provider_error"
