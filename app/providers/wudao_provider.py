"""悟道涨停事件池：每页最多一次计费调用，不自动重试。"""

from __future__ import annotations

import json
import math
import re
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date

import requests

from app.core.errors import ProviderError

_ENDPOINT = "https://stock.quicktiny.cn/api/mcp"
_PAGE_SIZE = 100
_ERROR_CODES = {
    "MISSING_API_KEY", "INVALID_API_KEY", "KEY_EXPIRED", "RATE_LIMIT_EXCEEDED",
    "DAILY_LIMIT_EXCEEDED", "FREE_TIER_MARKET_OPEN_RESTRICTED", "INVALID_ARGUMENTS",
    "UPSTREAM_UNAVAILABLE", "UPSTREAM_ERROR", "MARKET_SUMMARY_NOT_READY",
}


@dataclass(frozen=True, slots=True)
class WudaoPage:
    rows: list[dict]
    page: int
    page_size: int
    total: int
    total_pages: int
    raw: dict


def _day(value: object) -> date:
    if not isinstance(value, str) or not re.fullmatch(r"\d{8}|\d{4}-\d{2}-\d{2}", value):
        raise ProviderError("悟道记录日期格式异常")
    try:
        return date.fromisoformat(value)
    except ValueError:
        raise ProviderError("悟道记录日期无效") from None


def _check_metadata(value: dict, start: date, end: date, *, allow_raw_drop: bool = False) -> None:
    budget = value.get("budgetEnforcement")
    raw_only = (
        allow_raw_drop and value.get("qualityWarnings") == ["response_truncated"]
        and isinstance(budget, dict) and budget.get("actions") == ["rawData_dropped"]
    )
    if value.get("qualityWarnings") and not raw_only:
        raise ProviderError("悟道返回数据质量警告，未保存为完整结果")
    if budget is not None and (
        not isinstance(budget, dict) or budget.get("actions") and not raw_only
    ):
        raise ProviderError("悟道响应预算发生未知删减，未保存为完整结果")
    for key in ("dateMismatch", "fallback", "isFallback", "truncated", "isTruncated",
                "fallbackUsed", "fallbackReason", "partialErrors", "warnings", "missingFields"):
        if value.get(key):
            raise ProviderError("悟道返回日期回退、截断或数据质量警告，未保存为完整结果")
    status = value.get("dateStatus")
    if isinstance(status, str) and any(word in status.lower() for word in (
        "fallback", "mismatch", "previous", "next", "adjusted", "not_ready",
    )):
        raise ProviderError("悟道返回日期不匹配或数据未就绪")
    for key in ("actualTradeDate", "tradeDate", "date"):
        if value.get(key) is not None:
            if not start <= _day(value[key]) <= end:
                raise ProviderError("悟道实际交易日期超出请求区间")
    for key in ("standard", "dataFreshness", "quality"):
        child = value.get(key)
        if child is not None:
            if not isinstance(child, dict):
                raise ProviderError("悟道质量元数据结构异常")
            _check_metadata(child, start, end)


class WudaoProvider:
    """参考悟道官方 source-check 客户端处理初始化和 JSON/SSE 响应。"""

    def __init__(self, api_key: str, timeout: float = 20) -> None:
        if not isinstance(api_key, str) or not api_key.strip():
            raise ProviderError("尚未配置悟道 API Key")
        if any(character in api_key for character in ("\r", "\n")):
            raise ProviderError("悟道 API Key 格式异常")
        if not math.isfinite(timeout) or timeout <= 0:
            raise ValueError("悟道请求超时必须为有效正数")
        self._session = requests.Session()
        self._headers = {
            "Authorization": f"Bearer {api_key.strip()}",
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        }
        self._timeout = timeout
        self._next_id = 0
        self._initialized = False
        self.before_query: Callable[[], None] | None = None

    def close(self) -> None:
        self._session.close()

    def _rpc(self, method: str, params: dict | None = None, *, notification: bool = False):
        self._next_id += 1
        request = {"jsonrpc": "2.0", "method": method}
        if not notification:
            request["id"] = self._next_id
        if params is not None:
            request["params"] = params
        try:
            response = self._session.post(
                _ENDPOINT, json=request, headers=self._headers, timeout=self._timeout,
                allow_redirects=False,
            )
        except requests.RequestException:
            # 超时也可能已扣额度，调用方记账后停止，不自动重发。
            raise ProviderError("悟道网络请求失败；未自动重试，请稍后继续") from None
        if not 200 <= response.status_code < 300:
            label = {401: "认证失败", 403: "访问受限", 429: "额度或频率受限"}.get(
                response.status_code, "服务不可用",
            )
            raise ProviderError(f"悟道{label}（HTTP {response.status_code}）")
        session_id = response.headers.get("Mcp-Session-Id")
        if session_id:
            self._headers["Mcp-Session-Id"] = session_id
        if notification:
            return None
        try:
            if "text/event-stream" in response.headers.get("Content-Type", ""):
                messages = []
                for event in response.text.replace("\r\n", "\n").split("\n\n"):
                    data = "\n".join(
                        line[5:].lstrip() for line in event.splitlines() if line.startswith("data:")
                    )
                    if data:
                        messages.append(json.loads(data))
                body = next(
                    message for message in messages
                    if isinstance(message, dict) and message.get("id") == request["id"]
                )
            else:
                body = response.json()
        except (ValueError, StopIteration):
            raise ProviderError("悟道返回的 MCP 响应格式异常") from None
        if not isinstance(body, dict) or body.get("jsonrpc") != "2.0" or body.get("id") != request["id"]:
            raise ProviderError("悟道 MCP 响应编号或协议不匹配")
        if body.get("error"):
            error = body["error"]
            data = error.get("data") if isinstance(error, dict) else None
            code = data.get("error") if isinstance(data, dict) else None
            suffix = f"（{code}）" if isinstance(code, str) and code in _ERROR_CODES else ""
            raise ProviderError(f"悟道调用失败{suffix}")
        result = body.get("result")
        if not isinstance(result, dict):
            raise ProviderError("悟道 MCP 返回缺少结构化结果")
        return result

    def _initialize(self) -> None:
        if self._initialized:
            return
        result = self._rpc("initialize", {
            "protocolVersion": "2025-03-26", "capabilities": {},
            "clientInfo": {"name": "findstock", "version": "1.0"},
        })
        version = result.get("protocolVersion")
        if version not in {"2025-03-26", "2025-06-18", "2025-11-25", "2024-11-05"}:
            raise ProviderError("悟道返回不支持的 MCP 协议版本")
        self._headers["MCP-Protocol-Version"] = version
        self._rpc("notifications/initialized", notification=True)
        self._initialized = True

    def fetch_page(self, start: date, end: date, page: int) -> WudaoPage:
        if type(start) is not date or type(end) is not date or start > end:
            raise ValueError("悟道查询日期区间无效")
        if type(page) is not int or page < 1:
            raise ValueError("悟道页码必须为正整数")
        self._initialize()
        if self.before_query is not None:
            self.before_query()
        result = self._rpc("tools/call", {
            "name": "limit_up_filter",
            "arguments": {
                "startDate": start.isoformat(), "endDate": end.isoformat(),
                "page": page, "limit": _PAGE_SIZE,
                "sortBy": "first_limit_up_time", "sortOrder": "asc",
                "detailLevel": "raw", "includeReasonInfo": True, "format": "json",
            },
        })
        raw = result.get("structuredContent")
        if result.get("isError") or not isinstance(raw, dict) or raw.get("success") is not True:
            raise ProviderError("悟道涨停筛选调用失败或缺少结构化数据")
        data, meta = raw.get("data"), raw.get("meta", {})
        if not isinstance(data, dict) or not isinstance(meta, dict):
            raise ProviderError("悟道涨停筛选数据结构异常")
        for value in (raw, data):
            _check_metadata(value, start, end)
        # 已实测的预算处理仅删重复 rawData，规范化明细仍须逐行、逐页验全。
        _check_metadata(meta, start, end, allow_raw_drop=True)
        rows = data.get("rows") if "rows" in data else data.get("items")
        paging = data.get("pagination")
        if not isinstance(rows, list) or not isinstance(paging, dict):
            raise ProviderError("悟道涨停筛选缺少明细或分页信息")
        number, size, total, pages = (paging.get(key) for key in (
            "page", "pageSize", "total", "totalPages",
        ))
        if (any(type(value) is not int for value in (number, size, total, pages))
                or number != page or size != _PAGE_SIZE or total < 0
                or pages not in ({0, 1} if total == 0 else {math.ceil(total / size)})
                or page > max(1, pages)):
            raise ProviderError("悟道涨停筛选分页信息异常")
        expected = min(size, max(0, total - (page - 1) * size))
        if len(rows) != expected:
            raise ProviderError("悟道涨停筛选返回被截断或分页行数不完整")
        for key, expected_count in (("total", total), ("returned", len(rows))):
            if key in data and (type(data[key]) is not int or data[key] != expected_count):
                raise ProviderError("悟道明细计数与分页信息不一致")
        seen = set()
        for row in rows:
            if not isinstance(row, dict):
                raise ProviderError("悟道涨停记录格式异常")
            code = row.get("code")
            if not isinstance(code, str) or not re.fullmatch(r"\d{6}", code):
                raise ProviderError("悟道股票代码格式异常")
            day = _day(row.get("date"))
            if not start <= day <= end:
                raise ProviderError("悟道记录日期超出请求区间")
            identity = day, code
            if identity in seen:
                raise ProviderError("悟道同一交易日股票记录重复")
            seen.add(identity)
            if "primaryTheme" not in row or (
                row["primaryTheme"] is not None and not isinstance(row["primaryTheme"], str)
            ):
                raise ProviderError("悟道涨停主类字段缺失或格式异常")
            if "reasonType" in row and (
                row["reasonType"] is not None and not isinstance(row["reasonType"], str)
            ):
                raise ProviderError("悟道规范化原因字段格式异常")
        return WudaoPage(rows, number, size, total, pages, raw)
