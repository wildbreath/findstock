"""把领域异常映射为结构化 HTTP 错误。"""

from __future__ import annotations

import logging

from fastapi import FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from app.core.errors import (
    CalendarNotInitializedError,
    DataNotAvailableError,
    FindStockError,
    InsufficientHistoryError,
    InvalidRequestError,
    NotATradingDayError,
    ProviderError,
    StockNotFoundError,
    SyncAlreadyRunningError,
)

logger = logging.getLogger(__name__)

#: Starlette 新旧版本对 422 的常量命名不一致, 这里直接使用数值。
HTTP_UNPROCESSABLE = 422

_STATUS_BY_CODE: dict[str, int] = {
    CalendarNotInitializedError.code: status.HTTP_409_CONFLICT,
    DataNotAvailableError.code: status.HTTP_409_CONFLICT,
    SyncAlreadyRunningError.code: status.HTTP_409_CONFLICT,
    NotATradingDayError.code: HTTP_UNPROCESSABLE,
    InsufficientHistoryError.code: HTTP_UNPROCESSABLE,
    InvalidRequestError.code: HTTP_UNPROCESSABLE,
    ProviderError.code: status.HTTP_502_BAD_GATEWAY,
    StockNotFoundError.code: status.HTTP_404_NOT_FOUND,
}


def register_error_handlers(app: FastAPI) -> None:
    """注册全局异常处理器。"""

    @app.exception_handler(FindStockError)
    async def handle_domain_error(  # pragma: no cover - 通过 API 测试覆盖
        _request: Request, exc: FindStockError
    ) -> JSONResponse:
        details: dict[str, object] = {}
        if (
            isinstance(exc, (NotATradingDayError, DataNotAvailableError))
            and exc.suggested_date is not None
        ):
            details["suggested_date"] = exc.suggested_date.isoformat()
        if isinstance(exc, NotATradingDayError):
            details["selected_date"] = exc.selected_date.isoformat()
        if isinstance(exc, InsufficientHistoryError):
            details["selected_date"] = exc.selected_date.isoformat()
            details["available_before"] = exc.available_before
        if isinstance(exc, DataNotAvailableError):
            details["missing_dates"] = [day.isoformat() for day in exc.missing_dates]
            details["required_dates"] = [
                day.isoformat() for day in exc.required_dates
            ]

        return JSONResponse(
            status_code=_STATUS_BY_CODE.get(exc.code, status.HTTP_400_BAD_REQUEST),
            content={
                "error": {
                    "code": exc.code,
                    "message": exc.message,
                    "details": details,
                }
            },
        )

    @app.exception_handler(RequestValidationError)
    async def handle_validation_error(  # pragma: no cover
        _request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        return JSONResponse(
            status_code=HTTP_UNPROCESSABLE,
            content={
                "error": {
                    "code": "validation_error",
                    "message": "请求参数不合法",
                    "details": {"errors": _serializable_errors(exc)},
                }
            },
        )

    @app.exception_handler(Exception)
    async def handle_unexpected_error(  # pragma: no cover
        _request: Request, exc: Exception
    ) -> JSONResponse:
        logger.exception("未处理的服务端异常")
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={
                "error": {
                    "code": "internal_error",
                    "message": f"服务器内部错误: {type(exc).__name__}",
                    "details": {},
                }
            },
        )


def _serializable_errors(exc: RequestValidationError) -> list[dict[str, object]]:
    return [
        {"loc": list(error.get("loc", ())), "msg": error.get("msg", "")}
        for error in exc.errors()
    ]
