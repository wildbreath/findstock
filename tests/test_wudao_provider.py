"""悟道单页客户端契约测试，不访问网络、不消耗额度。"""

import copy
import json
from datetime import date

import pytest
import requests

from app.core.errors import InvalidRequestError, ProviderError
from app.providers.wudao_provider import WudaoProvider

START, END = date(2026, 10, 19), date(2026, 10, 23)
KEY = "lb_test_secret_never_log"


def output(rows=None, *, total=None, page=1):
    rows = rows if rows is not None else [{
        "date": "20261023", "code": "600000", "name": "测试股份",
        "primaryTheme": "机器人概念", "reasonType": "机器人", "reasonInfo": "源端完整原因",
        "extra": {"preserved": True},
    }]
    total = len(rows) if total is None else total
    return {"success": True, "data": {"rows": rows, "pagination": {
        "page": page, "pageSize": 100, "total": total, "totalPages": (total + 99) // 100,
    }}, "meta": {"actualTradeDate": "2026-10-23", "qualityWarnings": [], "partialErrors": []}}


def raw_drop_output():
    rows = [{"date": "20261023", "code": f"{600000 + index:06}", "name": "测试股份",
             "primaryTheme": "机器人概念", "reasonType": "机器人"} for index in range(100)]
    raw = output(rows, total=3890)
    raw["data"].update(total=3890, returned=100)
    raw["meta"].update(
        qualityWarnings=["response_truncated"],
        budgetEnforcement={"budget": 80000, "finalCharLength": 65725, "actions": ["rawData_dropped"]},
        quality={"warnings": [], "missingFields": [], "rawIncluded": True},
        standard={"tradeDate": "20261023", "actualTradeDate": "20261023", "dateStatus": "in_range",
                  "dataFreshness": {"fallbackUsed": False, "fallbackReason": None}},
    )
    return raw


class Response:
    def __init__(self, body=None, *, status=200, headers=None, text=""):
        self.body = body
        self.status_code = status
        self.headers = headers or {}
        self.text = text

    def json(self):
        if self.body is None:
            raise ValueError(KEY)
        return self.body


class Transport:
    def __init__(self):
        self.calls = []
        self.result = {"structuredContent": output(), "isError": False}
        self.reply = None
        self.closed = False

    def post(self, endpoint, **kwargs):
        self.calls.append((endpoint, copy.deepcopy(kwargs)))
        message = kwargs["json"]
        if message["method"] == "initialize":
            return Response({"jsonrpc": "2.0", "id": message["id"],
                             "result": {"protocolVersion": "2025-03-26"}},
                            headers={"Mcp-Session-Id": "test-session"})
        if message["method"] == "notifications/initialized":
            return Response(status=202)
        if self.reply:
            return self.reply(message)
        return Response({"jsonrpc": "2.0", "id": message["id"], "result": self.result})

    def close(self):
        self.closed = True


@pytest.fixture()
def client(monkeypatch):
    transport = Transport()
    monkeypatch.setattr(requests, "Session", lambda: transport)
    return WudaoProvider(KEY, timeout=6), transport


def test_requests_maximum_page_raw_fields_once_and_keeps_original_response(client):
    provider, transport = client
    original = transport.result["structuredContent"]
    result = provider.fetch_page(START, END, 1)
    assert (result.page, result.page_size, result.total, result.total_pages) == (1, 100, 1, 1)
    assert result.rows is original["data"]["rows"] and result.raw is original
    endpoint, request = transport.calls[-1]
    assert endpoint == "https://stock.quicktiny.cn/api/mcp" and request["timeout"] == 6
    assert request["allow_redirects"] is False
    assert request["headers"]["Authorization"] == f"Bearer {KEY}"
    assert request["headers"]["Mcp-Session-Id"] == "test-session"
    assert request["headers"]["MCP-Protocol-Version"] == "2025-03-26"
    assert request["json"]["params"] == {"name": "limit_up_filter", "arguments": {
        "startDate": "2026-10-19", "endDate": "2026-10-23", "page": 1, "limit": 100,
        "sortBy": "first_limit_up_time", "sortOrder": "asc",
        "detailLevel": "raw", "includeReasonInfo": True, "format": "json",
    }}
    provider.fetch_page(START, END, 1)
    methods = [call[1]["json"]["method"] for call in transport.calls]
    assert methods == ["initialize", "notifications/initialized", "tools/call", "tools/call"]
    provider.close()
    assert transport.closed


def test_query_guard_after_initialization_can_stop_without_a_billed_call(client):
    provider, transport = client
    assert provider.before_query is None

    def blocked():
        methods = [call[1]["json"]["method"] for call in transport.calls]
        assert methods == ["initialize", "notifications/initialized"]
        raise InvalidRequestError("已进入交易日，请在15:30后继续")

    provider.before_query = blocked
    with pytest.raises(InvalidRequestError, match="15:30"):
        provider.fetch_page(START, END, 1)
    assert [call[1]["json"]["method"] for call in transport.calls] == [
        "initialize", "notifications/initialized",
    ]


def test_query_guard_is_checked_for_each_page_without_reinitialization(client):
    provider, transport = client
    calls = []
    provider.before_query = lambda: calls.append("allowed")
    provider.fetch_page(START, END, 1)

    def blocked():
        raise InvalidRequestError("15:30前禁止查询")

    provider.before_query = blocked
    with pytest.raises(InvalidRequestError):
        provider.fetch_page(START, END, 1)
    assert calls == ["allowed"]
    assert [call[1]["json"]["method"] for call in transport.calls] == [
        "initialize", "notifications/initialized", "tools/call",
    ]


def test_accepts_items_wrapper_without_changing_raw(client):
    provider, transport = client
    data = transport.result["structuredContent"]["data"]
    data["items"] = data.pop("rows")
    assert provider.fetch_page(START, END, 1).rows == data["items"]


@pytest.mark.parametrize("theme", [None, "", "  "])
def test_empty_primary_theme_is_not_replaced_with_industry(client, theme):
    provider, transport = client
    row = transport.result["structuredContent"]["data"]["rows"][0]
    row.update(primaryTheme=theme, industry="软件", reasonType="AI")
    assert provider.fetch_page(START, END, 1).rows[0]["primaryTheme"] == theme


def test_keeps_beijing_and_st_records_for_local_service_to_match(client):
    provider, transport = client
    raw = output([{"date": "2026-10-23", "code": "920075", "name": "ST测试", "primaryTheme": "算力"}])
    transport.result["structuredContent"] = raw
    assert provider.fetch_page(START, END, 1).rows == raw["data"]["rows"]


def test_accepts_full_first_page_and_short_last_page(client):
    provider, transport = client
    rows = [{"date": "2026-10-23", "code": f"{number:06}", "primaryTheme": "芯片"}
            for number in range(1, 101)]
    transport.result["structuredContent"] = output(rows, total=101)
    assert len(provider.fetch_page(START, END, 1).rows) == 100
    transport.result["structuredContent"] = output(rows[:1], total=101, page=2)
    assert len(provider.fetch_page(START, END, 2).rows) == 1


@pytest.mark.parametrize("pages", [0, 1])
def test_zero_records_is_valid_but_not_a_fabricated_theme(client, pages):
    provider, transport = client
    raw = output([])
    raw["data"]["pagination"]["totalPages"] = pages
    transport.result["structuredContent"] = raw
    assert provider.fetch_page(START, END, 1).rows == []


@pytest.mark.parametrize("field,value", [
    ("page", 2), ("page", True), ("pageSize", 20), ("total", -1),
    ("total", "1"), ("totalPages", 2), ("totalPages", None),
])
def test_rejects_invalid_pagination(client, field, value):
    provider, transport = client
    transport.result["structuredContent"]["data"]["pagination"][field] = value
    with pytest.raises(ProviderError, match="分页"):
        provider.fetch_page(START, END, 1)


def test_rejects_truncated_rows_even_when_pagination_claims_success(client):
    provider, transport = client
    transport.result["structuredContent"] = output(total=2)
    with pytest.raises(ProviderError, match="截断"):
        provider.fetch_page(START, END, 1)


@pytest.mark.parametrize("field,value", [
    ("date", "2026-10-16"), ("date", "20261024"), ("date", "2026-02-30"),
    ("date", None), ("date", "2026-10-23T00:00:00Z"), ("code", 600000),
    ("code", "sh.600000"), ("primaryTheme", ["芯片"]), ("primaryTheme", 1),
])
def test_rejects_invalid_row_values(client, field, value):
    provider, transport = client
    transport.result["structuredContent"]["data"]["rows"][0][field] = value
    with pytest.raises(ProviderError):
        provider.fetch_page(START, END, 1)


def test_rejects_missing_primary_theme_without_guessing(client):
    provider, transport = client
    del transport.result["structuredContent"]["data"]["rows"][0]["primaryTheme"]
    with pytest.raises(ProviderError, match="主类字段"):
        provider.fetch_page(START, END, 1)


def test_duplicate_normalizes_both_date_spellings(client):
    provider, transport = client
    raw = transport.result["structuredContent"]
    duplicate = {**raw["data"]["rows"][0], "date": "2026-10-23"}
    transport.result["structuredContent"] = output([raw["data"]["rows"][0], duplicate])
    with pytest.raises(ProviderError, match="重复"):
        provider.fetch_page(START, END, 1)


@pytest.mark.parametrize("field,value", [
    ("dateMismatch", True), ("fallback", "2026-10-16"), ("truncated", True),
    ("qualityWarnings", ["partial"]), ("partialErrors", {"source": "failed"}),
    ("actualTradeDate", "2026-10-16"), ("dateStatus", "fallback_previous_trading_day"),
])
def test_rejects_date_fallback_and_partial_metadata(client, field, value):
    provider, transport = client
    transport.result["structuredContent"]["meta"][field] = value
    with pytest.raises(ProviderError):
        provider.fetch_page(START, END, 1)


def test_timeout_is_not_retried_and_secret_is_not_exposed(client):
    provider, transport = client

    def timeout(message):
        raise requests.Timeout(KEY)

    transport.reply = timeout
    with pytest.raises(ProviderError, match="未自动重试") as exc:
        provider.fetch_page(START, END, 1)
    assert KEY not in str(exc.value)
    assert sum(call[1]["json"]["method"] == "tools/call" for call in transport.calls) == 1


@pytest.mark.parametrize("status", [307, 401, 403, 429, 500])
def test_http_failures_are_sanitized_and_not_retried(client, status):
    provider, transport = client
    transport.reply = lambda message: Response({"secret": KEY}, status=status, text=KEY)
    with pytest.raises(ProviderError, match=f"HTTP {status}") as exc:
        provider.fetch_page(START, END, 1)
    assert KEY not in str(exc.value) and len(transport.calls) == 3


def test_rpc_error_only_exposes_known_safe_error_code(client):
    provider, transport = client
    transport.reply = lambda message: Response({"jsonrpc": "2.0", "id": message["id"],
        "error": {"message": KEY, "data": {"error": "DAILY_LIMIT_EXCEEDED", "key": KEY}}})
    with pytest.raises(ProviderError, match="DAILY_LIMIT_EXCEEDED") as exc:
        provider.fetch_page(START, END, 1)
    assert KEY not in str(exc.value)


@pytest.mark.parametrize("result", [
    {"isError": True, "structuredContent": {"error": "INVALID_ARGUMENTS", "secret": KEY}},
    {"structuredContent": {"success": False, "message": KEY}},
    {"content": [{"type": "text", "text": KEY}]},
])
def test_tool_errors_and_text_only_summary_are_not_data(client, result):
    provider, transport = client
    transport.result = result
    with pytest.raises(ProviderError) as exc:
        provider.fetch_page(START, END, 1)
    assert KEY not in str(exc.value)


def test_sse_response_uses_matching_id_and_structured_data(client):
    provider, transport = client

    def sse(message):
        body = {"jsonrpc": "2.0", "id": message["id"], "result": transport.result}
        return Response(headers={"Content-Type": "text/event-stream; charset=utf-8"}, text=(
            'event: message\r\ndata: {"jsonrpc":"2.0","method":"notifications/message"}\r\n\r\n'
            f'event: message\r\ndata: {json.dumps(body)}\r\n\r\n'
        ))

    transport.reply = sse
    assert provider.fetch_page(START, END, 1).rows[0]["primaryTheme"] == "机器人概念"


@pytest.mark.parametrize("body", [None, [], {"jsonrpc": "2.0", "id": -1, "result": {}}])
def test_malformed_rpc_response_is_sanitized(client, body):
    provider, transport = client
    transport.reply = lambda message: Response(body)
    with pytest.raises(ProviderError) as exc:
        provider.fetch_page(START, END, 1)
    assert KEY not in str(exc.value)


@pytest.mark.parametrize("key", [None, "", "   ", "lb_test\r\nInjected: value"])
def test_missing_or_invalid_key_does_not_send_requests(key, monkeypatch):
    monkeypatch.setattr(requests, "Session", lambda: pytest.fail("must not create a session"))
    with pytest.raises(ProviderError):
        WudaoProvider(key)


@pytest.mark.parametrize("start,end,page", [(END, START, 1), (START, END, 0), (START, END, True)])
def test_invalid_query_does_not_spend_a_call(client, start, end, page):
    provider, transport = client
    with pytest.raises(ValueError):
        provider.fetch_page(start, end, page)
    assert transport.calls == []


def test_known_raw_only_budget_drop_keeps_complete_page_and_original_warnings(client):
    provider, transport = client
    raw = raw_drop_output()
    original = copy.deepcopy(raw)
    transport.result["structuredContent"] = raw
    result = provider.fetch_page(START, END, 1)
    assert len(result.rows) == 100 and result.total == 3890 and result.total_pages == 39
    assert result.raw is raw and result.raw == original
    assert result.raw["meta"]["qualityWarnings"] == ["response_truncated"]
    assert result.raw["meta"]["budgetEnforcement"]["actions"] == ["rawData_dropped"]
    assert len(transport.calls) == 3


@pytest.mark.parametrize("warnings,actions", [
    (["response_truncated", "partial"], ["rawData_dropped"]),
    (["response_truncated"], ["rawData_dropped", "rows_dropped"]),
    (["response_truncated"], ["rows_dropped"]),
    (["response_truncated"], ["rawData_dropped", "rawData_dropped"]),
    (["response_truncated"], "rawData_dropped"),
    (["response_truncated"], []), (["response_truncated"], None),
    ([], ["rawData_dropped"]),
])
def test_budget_exception_is_limited_to_one_known_warning_and_action(client, warnings, actions):
    provider, transport = client
    raw = raw_drop_output()
    raw["meta"]["qualityWarnings"] = warnings
    raw["meta"]["budgetEnforcement"]["actions"] = actions
    transport.result["structuredContent"] = raw
    with pytest.raises(ProviderError):
        provider.fetch_page(START, END, 1)


@pytest.mark.parametrize("section,field,value", [
    ("quality", "warnings", ["missing_source"]),
    ("quality", "missingFields", ["primaryTheme"]),
    ("standard", "fallbackUsed", True),
    ("standard", "actualTradeDate", "20261016"),
    ("standard", "dateStatus", "fallback_previous_trading_day"),
    ("standard", "partialErrors", ["source"]),
    ("dataFreshness", "fallbackUsed", True),
    ("dataFreshness", "fallbackReason", "previous_trade_date"),
])
def test_raw_drop_never_exempts_nested_quality_or_date_problems(client, section, field, value):
    provider, transport = client
    raw = raw_drop_output()
    parent = raw["meta"]["standard"] if section == "dataFreshness" else raw["meta"]
    parent[section][field] = value
    transport.result["structuredContent"] = raw
    with pytest.raises(ProviderError):
        provider.fetch_page(START, END, 1)


def test_raw_drop_does_not_allow_missing_rows(client):
    provider, transport = client
    raw = raw_drop_output()
    raw["data"]["rows"].pop()
    transport.result["structuredContent"] = raw
    with pytest.raises(ProviderError, match="截断"):
        provider.fetch_page(START, END, 1)


@pytest.mark.parametrize("field,value", [("total", 100), ("returned", 99), ("returned", "100")])
def test_raw_drop_rejects_conflicting_canonical_counts(client, field, value):
    provider, transport = client
    raw = raw_drop_output()
    raw["data"][field] = value
    transport.result["structuredContent"] = raw
    with pytest.raises(ProviderError, match="计数"):
        provider.fetch_page(START, END, 1)


def test_raw_drop_rejects_invalid_optional_reason_type(client):
    provider, transport = client
    raw = raw_drop_output()
    raw["data"]["rows"][0]["reasonType"] = ["机器人"]
    transport.result["structuredContent"] = raw
    with pytest.raises(ProviderError, match="原因字段"):
        provider.fetch_page(START, END, 1)


@pytest.mark.parametrize("value", [None, "", "  "])
def test_raw_drop_keeps_explicit_unclassified_theme_without_guessing(client, value):
    provider, transport = client
    raw = raw_drop_output()
    raw["data"]["rows"][0]["primaryTheme"] = value
    transport.result["structuredContent"] = raw
    result = provider.fetch_page(START, END, 1)
    assert result.rows[0]["primaryTheme"] == value
    assert result.raw is raw


def test_raw_drop_allows_beijing_stock_without_optional_reason_type(client):
    provider, transport = client
    raw = raw_drop_output()
    row = raw["data"]["rows"][0]
    row.update(code="920690", primaryTheme="芯片")
    del row["reasonType"]
    transport.result["structuredContent"] = raw
    result = provider.fetch_page(START, END, 1)
    assert result.rows[0]["code"] == "920690" and result.rows[0]["primaryTheme"] == "芯片"
    assert "reasonType" not in result.rows[0]


def test_raw_drop_rejects_deleted_canonical_primary_theme_key(client):
    provider, transport = client
    raw = raw_drop_output()
    del raw["data"]["rows"][0]["primaryTheme"]
    transport.result["structuredContent"] = raw
    with pytest.raises(ProviderError):
        provider.fetch_page(START, END, 1)


def test_explicit_truncation_flag_is_not_the_raw_only_budget_exception(client):
    provider, transport = client
    raw = raw_drop_output()
    raw["meta"]["truncated"] = True
    transport.result["structuredContent"] = raw
    with pytest.raises(ProviderError):
        provider.fetch_page(START, END, 1)
