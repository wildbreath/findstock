"""同花顺公开历史涨停池，连板数取独立的连续涨停统计。"""

import math
import re
from datetime import date, datetime, timedelta, timezone

import requests

from app.domain.ladder import LimitUpStock
from app.domain.st_policy import is_st_name
from app.domain.symbols import detect_board, is_a_share_code

_BASE = "https://data.10jqka.com.cn/dataapi/limit_up/"
_FIELDS = "199112,10,9001,330323,330324,330325,9002,330329,133971,133970,1968584,3475914,9003,9004"
_TZ = timezone(timedelta(hours=8))


def fetch_ths_ladder(day: date, timeout: float) -> list[LimitUpStock]:
    def get(endpoint, **params):
        response = requests.get(
            _BASE + endpoint, params={"date": day.strftime("%Y%m%d"), **params},
            headers={"User-Agent": "Mozilla/5.0", "Referer": "https://data.10jqka.com.cn/limit_up/"},
            timeout=timeout,
        )
        response.raise_for_status()
        body = response.json()
        if not isinstance(body, dict) or body.get("status_code") != 0:
            raise ValueError("同花顺涨停数据不可用")
        return body.get("data")

    rows, total, pages = [], None, 1
    page = 1
    while page <= pages:
        data = get("limit_up_pool", page=page, limit=200, field=_FIELDS,
                   filter="HS,GEM2STAR", order_field="330324", order_type=0)
        if not isinstance(data, dict) or data.get("date") != day.strftime("%Y%m%d"):
            raise ValueError("同花顺股池日期不匹配")
        info, paging = data.get("info"), data.get("page")
        if not isinstance(info, list) or not isinstance(paging, dict):
            raise ValueError("同花顺股池分页格式异常")
        count, page_count = paging.get("total"), paging.get("count")
        if (type(count) is not int or not 0 <= count <= 6000 or
                type(page_count) is not int or not 0 <= page_count <= 30 or
                paging.get("page") != page or page_count != math.ceil(count / 200)):
            raise ValueError("同花顺股池分页信息异常")
        if total is not None and (count != total or page_count != pages):
            raise ValueError("同花顺股池分页期间发生变化，请重试")
        total, pages = count, page_count
        rows.extend(info)
        page += 1
    if len(rows) != total:
        raise ValueError("同花顺股池行数不完整")
    if not rows:
        return []

    groups = get("continuous_limit_up")
    if not isinstance(groups, list):
        raise ValueError("同花顺连续涨停统计格式异常")
    consecutive = {}
    for group in groups:
        if not isinstance(group, dict) or not isinstance(group.get("code_list"), list):
            raise ValueError("同花顺连续涨停分组异常")
        if group.get("number") != len(group["code_list"]):
            raise ValueError("同花顺连续涨停分组不完整")
        for item in group["code_list"]:
            symbol, number = item.get("code"), item.get("continue_num")
            if (not isinstance(symbol, str) or not re.fullmatch(r"\d{6}", symbol) or
                    type(number) is not int or number < 2 or number != group.get("height") or symbol in consecutive):
                raise ValueError("同花顺连续涨停数异常")
            consecutive[symbol] = number

    def number(value):
        if value is None:
            return None
        result = float(value)
        if not math.isfinite(result):
            raise ValueError("同花顺股池数值异常")
        return result

    def seal_time(value):
        if value in (None, "", 0, "0"):
            return None
        instant = datetime.fromtimestamp(int(value), _TZ)
        if instant.date() != day:
            raise ValueError("同花顺封板时间日期不匹配")
        return instant.strftime("%H:%M:%S")

    items, seen = [], set()
    for row in rows:
        symbol = row.get("code")
        if not isinstance(symbol, str) or not re.fullmatch(r"\d{6}", symbol) or symbol in seen:
            raise ValueError("同花顺股池股票代码缺失或重复")
        seen.add(symbol)
        code = f"{'sh' if symbol.startswith('6') else 'sz'}.{symbol}"
        if not is_a_share_code(code):
            continue
        name = row.get("name")
        if not isinstance(name, str) or not name.strip():
            raise ValueError("同花顺股池股票名称缺失")
        height = consecutive.get(symbol, 1)
        # 历史 high_days 标签也可能错位；连板数只采用独立的 continuous_limit_up 统计。
        breaks = number(row.get("open_num"))
        if breaks is not None and (breaks < 0 or not breaks.is_integer()):
            raise ValueError("同花顺炸板次数异常")
        board = detect_board(code)
        items.append(LimitUpStock(
            code=code, name=name.strip(), consecutive=height,
            price=number(row.get("latest")), pct_chg=number(row.get("change_rate")),
            amount=None, turnover=number(row.get("turnover_rate")),
            seal_funds=number(row.get("order_amount")),
            first_seal=seal_time(row.get("first_limit_up_time")),
            last_seal=seal_time(row.get("last_limit_up_time")),
            breaks=int(breaks) if breaks is not None else None,
            industry="", board=board.value, board_label=board.label, is_st=is_st_name(name),
        ))
    if any(symbol not in seen for symbol in consecutive):
        raise ValueError("同花顺连续涨停股票未在涨停池中，数据不完整")
    return items
