"""akshare 数据源实现。

用到的接口与上游:

======================  ===========================  ==================================
需求                     akshare 接口                 上游 / 说明
======================  ===========================  ==================================
交易日历                 ``tool_trade_date_hist_sina``  新浪, 一次返回全部交易日
股票列表 + 当前简称      ``stock_zh_a_spot``          新浪, 全市场快照
日线行情                 ``stock_zh_a_daily``         新浪 (前复权), 备用腾讯接口
历史简称                 ``stock_info_change_name``   新浪, 顺序列表 (无日期)
======================  ===========================  ==================================

两个必须说明的口径问题:

1. **涨跌幅**: 由 **前复权** 的相邻有效收盘价计算，保留四位小数，
   不伪装成交易所直接返回的涨跌幅。复牌时保留停牌前的真实收盘价；
   CDR 使用新浪独立接口。源端价格精度会影响涨跌幅精度。

2. **历史 ST**: akshare 没有 "某天是否为 ST" 的字段, 只能拿到当前简称与
   不带日期的历史简称序列, 因此历史日期的 ST 判定由
   :mod:`app.domain.st_policy` 结合涨跌幅上限推断。
"""

from __future__ import annotations

import logging
import math
import re
import time
from datetime import UTC, date, datetime, timedelta

import akshare as ak
import pandas as pd
import requests

from app.core.errors import DataNotAvailableError, ProviderError
from app.domain.ladder import LimitUpStock
from app.domain.models import DailyBar
from app.domain.rules import is_st_name
from app.domain.sectors import StockSector, StockSectors
from app.domain.symbols import detect_board, is_a_share_code, split_code
from app.providers.base import StockSnapshot
from app.providers.http_timeout import (
    DEFAULT_TIMEOUT_SECONDS,
    install_default_timeout,
)

logger = logging.getLogger(__name__)

#: 计算涨幅需要的前置天数 (给节假日留足冗余)。
WARMUP_DAYS = 15


def to_symbol(code: str) -> str:
    """``sh.600000`` -> ``sh600000`` (akshare 使用的形式)。"""

    exchange, symbol = split_code(code)
    return f"{exchange.value}{symbol}"


def from_symbol(symbol: str) -> str:
    """``sh600000`` -> ``sh.600000``。"""

    return f"{symbol[:2]}.{symbol[2:]}"


def _as_float(value: object) -> float | None:
    if value is None:
        return None
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return None if pd.isna(result) else result


class AkshareProvider:
    """基于 akshare 的沪深A股数据源。"""

    name = "akshare"
    price_adjustment = "qfq"

    def __init__(
        self,
        *,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        max_attempts: int = 3,
        backoff_seconds: float = 1.5,
    ) -> None:
        self._timeout = timeout
        self._max_attempts = max(1, max_attempts)
        self._backoff = backoff_seconds
        self._calendar_cache: list[date] | None = None
        # akshare 很多内部请求没有 timeout, 必须补上, 否则线程会永久挂住。
        install_default_timeout(timeout)

    # --- 会话 (akshare 是无状态 HTTP, 这里只是留出预热/清理的位置) ----------

    def open(self) -> None:
        """预热: 预先取一次交易日历, 后续调用可复用。"""

        self._load_calendar()

    def close(self) -> None:
        """无状态, 无需释放。"""

    # --- 内部: 带重试的调用 ----------------------------------------------

    def _call(self, description: str, func, *args, **kwargs):
        last_error: str = "未知错误"
        for attempt in range(1, self._max_attempts + 1):
            try:
                return func(*args, **kwargs)
            except DataNotAvailableError:
                raise
            except Exception as exc:  # noqa: BLE001 - 统一转成 ProviderError
                last_error = f"{type(exc).__name__}: {exc}"
                logger.warning(
                    "%s 第 %d/%d 次失败: %s", description, attempt, self._max_attempts, last_error
                )
                if attempt < self._max_attempts:
                    time.sleep(self._backoff * attempt)
        raise ProviderError(f"{description} 连续 {self._max_attempts} 次失败: {last_error}")

    # --- 交易日历 ---------------------------------------------------------

    def _load_calendar(self) -> list[date]:
        if self._calendar_cache is None:
            frame = self._call("tool_trade_date_hist_sina", ak.tool_trade_date_hist_sina)
            self._calendar_cache = [
                value.date() if hasattr(value, "date") else value
                for value in frame["trade_date"].tolist()
            ]
        return self._calendar_cache

    def fetch_trading_calendar(self, start: date, end: date) -> list[tuple[date, bool]]:
        """区间内每个自然日是否为交易日。

        数据源给出的是 "官方交易日历", 包含尚未到来的未来交易日,
        调用方需要自行按实际可获取的数据截断。
        """

        open_days = set(self._load_calendar())
        days: list[tuple[date, bool]] = []
        cursor = start
        while cursor <= end:
            days.append((cursor, cursor in open_days))
            cursor += timedelta(days=1)
        return days

    def latest_calendar_day(self) -> date | None:
        """日历中最后一个交易日 (可能是未来日期)。"""

        days = self._load_calendar()
        return max(days) if days else None

    # --- 股票列表 ---------------------------------------------------------

    def fetch_stock_universe(self, day: date) -> list[StockSnapshot]:  # noqa: ARG002
        """全市场沪深A股及其 **当前** 简称。

        ``day`` 参数对 akshare 无意义 (它只有实时快照), 保留是为了满足统一接口;
        调用方必须把结果记在实际取数的交易日上。
        """

        frame = self._call("stock_zh_a_spot", ak.stock_zh_a_spot)
        snapshots: list[StockSnapshot] = []
        for raw_code, raw_name in zip(frame["代码"], frame["名称"], strict=False):
            symbol = str(raw_code).strip().lower()
            code = from_symbol(symbol) if len(symbol) == 8 else symbol
            if not is_a_share_code(code):
                continue
            name = str(raw_name).strip()
            snapshots.append(StockSnapshot(code=code, name=name, is_trading=True))
        if not snapshots:
            raise ProviderError("stock_zh_a_spot 未返回任何沪深A股")
        return snapshots

    # --- 涨停股池 ---------------------------------------------------------

    def fetch_listing_dates(self) -> dict[str, date]:
        dates: dict[str, date] = {}
        sources = [
            (ak.stock_info_sh_name_code, "主板A股", "证券代码", "上市日期", "sh"),
            (ak.stock_info_sh_name_code, "科创板", "证券代码", "上市日期", "sh"),
            (ak.stock_info_sz_name_code, "A股列表", "A股代码", "A股上市日期", "sz"),
        ]
        for fetch, symbol, code_col, date_col, exchange in sources:
            frame = self._call(f"上市日期({symbol})", fetch, symbol=symbol)
            if (not isinstance(frame, pd.DataFrame)
                    or not {code_col, date_col}.issubset(frame.columns)):
                raise ProviderError(f"{symbol}上市日期返回格式异常")
            for raw_code, raw_day in zip(frame[code_col], frame[date_col], strict=True):
                code = f"{exchange}.{str(raw_code).zfill(6)}"
                day = pd.to_datetime(raw_day, errors="coerce")
                if is_a_share_code(code) and not pd.isna(day):
                    dates[code] = day.date()
        if not dates:
            raise ProviderError("交易所未返回上市日期，无法核对上市前缺行")
        return dates

    def fetch_suspended_codes(self, day: date) -> set[str]:
        frame = self._call("停复牌信息", ak.stock_tfp_em, date=day.strftime("%Y%m%d"))
        required = {"代码", "停牌时间", "停牌期限"}
        if not isinstance(frame, pd.DataFrame) or not required.issubset(frame.columns):
            raise ProviderError("停复牌信息返回格式异常，无法确认缺行原因")
        codes = set()
        for row in frame.to_dict("records"):
            symbol = str(row["代码"]).zfill(6)
            code = f"{'sh' if symbol.startswith('6') else 'sz'}.{symbol}"
            started = pd.to_datetime(row["停牌时间"], errors="coerce")
            ended = pd.to_datetime(row.get("停牌截止时间"), errors="coerce")
            duration = str(row["停牌期限"]).strip()
            full_day = duration in {"连续停牌", "全天停牌", "停牌一天", "停牌1天"}
            # 盘中临停不能解释整日无行情；无法识别的期限也不当作全天停牌。
            if (is_a_share_code(code) and not pd.isna(started)
                    and started.date() <= day and full_day
                    and (pd.isna(ended) or day <= ended.date())):
                codes.add(code)
        return codes

    def fetch_delisting_dates(self) -> dict[str, date]:
        """仅使用交易所终止上市名单，不从行情消失推断退市。"""
        dates = {}
        for fetch, symbol, code_col, date_col, exchange in [
            (ak.stock_info_sh_delist, "全部", "公司代码", "暂停上市日期", "sh"),
            (ak.stock_info_sz_delist, "终止上市公司", "证券代码", "终止上市日期", "sz"),
        ]:
            frame = self._call(f"终止上市日期({exchange})", fetch, symbol=symbol)
            if not isinstance(frame, pd.DataFrame) or not {code_col, date_col} <= set(frame):
                raise ProviderError(f"{exchange}终止上市名单返回格式异常")
            for raw_code, raw_day in zip(frame[code_col], frame[date_col], strict=True):
                code = f"{exchange}.{str(raw_code).zfill(6)}"
                day = pd.to_datetime(raw_day, errors="coerce")
                if is_a_share_code(code) and not pd.isna(day):
                    dates[code] = day.date()
        return dates

    def fetch_limit_up_pool(self, day: date) -> list[LimitUpStock]:
        frame = self._call("涨停股池", ak.stock_zt_pool_em, date=day.strftime("%Y%m%d"))
        if not isinstance(frame, pd.DataFrame):
            raise ProviderError("涨停股池返回格式异常, 请稍后重试。")
        if frame.empty:
            return []
        if not {"代码", "名称", "连板数"}.issubset(frame.columns):
            raise ProviderError("涨停股池缺少代码、名称或连板数, 请检查数据源。")

        def number(row, key):
            value = _as_float(row.get(key))
            return value if value is not None and math.isfinite(value) else None

        def seal_time(value):
            if value is None or pd.isna(value):
                return None
            digits = str(value).strip().replace(":", "").zfill(6)
            if not digits.isdigit() or len(digits) != 6:
                return None
            if int(digits[:2]) > 23 or int(digits[2:4]) > 59 or int(digits[4:]) > 59:
                return None
            return f"{digits[:2]}:{digits[2:4]}:{digits[4:]}"

        items = []
        for row in frame.to_dict("records"):
            symbol = str(row["代码"]).strip().zfill(6)
            code = f"{'sh' if symbol.startswith('6') else 'sz'}.{symbol}"
            if not is_a_share_code(code):
                continue
            consecutive = number(row, "连板数")
            name = row["名称"]
            if (
                consecutive is None or consecutive < 1 or not consecutive.is_integer()
                or pd.isna(name) or not str(name).strip()
            ):
                raise ProviderError("涨停股池的名称或连板数异常, 请稍后重试。")
            name = str(name).strip()
            board = detect_board(code)
            breaks = number(row, "炸板次数")
            industry = row.get("所属行业")
            items.append(LimitUpStock(
                code=code, name=name, consecutive=int(consecutive),
                price=number(row, "最新价"), pct_chg=number(row, "涨跌幅"),
                amount=number(row, "成交额"), turnover=number(row, "换手率"),
                seal_funds=number(row, "封板资金"),
                first_seal=seal_time(row.get("首次封板时间")),
                last_seal=seal_time(row.get("最后封板时间")),
                breaks=int(breaks) if breaks is not None else None,
                industry=str(industry) if industry is not None and not pd.isna(industry) else "",
                board=board.value, board_label=board.label, is_st=is_st_name(name),
            ))
        return items

    def fetch_limit_up_pool_ths(self, day: date) -> list[LimitUpStock]:
        from app.providers.ths_ladder import fetch_ths_ladder
        return self._call("同花顺历史涨停池", fetch_ths_ladder, day, self._timeout)

    # --- 当前行业与题材板块 -----------------------------------------------

    def fetch_stock_sectors(self, code: str) -> StockSectors:
        exchange, symbol = split_code(code)
        if not is_a_share_code(code):
            raise ProviderError("板块查询仅支持沪深 A 股。")
        url = "https://datacenter-web.eastmoney.com/api/data/v1/get"
        params = {
            "reportName": "RPT_F10_CORETHEME_BOARDTYPE", "columns": "ALL",
            "filter": f'(SECURITY_CODE="{symbol}")',
            "sortColumns": "BOARD_RANK", "sortTypes": "1",
            "pageSize": 100, "pageNumber": 1, "source": "WEB", "client": "WEB",
        }

        def fetch_page():
            response = requests.get(url, params=params, timeout=self._timeout)
            response.raise_for_status()
            payload = response.json()
            result = payload.get("result") if isinstance(payload, dict) else None
            if not isinstance(result, dict) or not isinstance(result.get("data"), list):
                raise ValueError("所属板块返回格式异常或数据未提供")
            pages = result.get("pages")
            if not isinstance(pages, int) or not 1 <= pages <= 20:
                raise ValueError("所属板块分页信息异常")
            return result

        result = self._call(f"所属板块({code})", fetch_page)
        rows = result["data"][:]
        for page in range(2, result["pages"] + 1):
            params["pageNumber"] = page
            rows.extend(self._call(f"所属板块({code}) 第 {page} 页", fetch_page)["data"])
        sectors = {}
        for row in rows:
            if not isinstance(row, dict) or row.get("SECURITY_CODE") != symbol:
                raise ProviderError("所属板块返回了不匹配的股票代码。")
            board_code = row.get("NEW_BOARD_CODE")
            name = row.get("BOARD_NAME")
            if not isinstance(board_code, str) or not re.fullmatch(r"BK\d{4,6}", board_code):
                raise ProviderError("所属板块缺少有效的源端板块代码。")
            if not isinstance(name, str) or not name.strip():
                raise ProviderError("所属板块缺少有效名称。")
            source_type = row.get("BOARD_TYPE")
            reason = row.get("SELECTED_BOARD_REASON")
            if ((source_type is not None and not isinstance(source_type, str))
                    or (reason is not None and not isinstance(reason, str))):
                raise ProviderError("所属板块的类型或入选依据格式异常。")
            level = row.get("BOARD_LEVEL")
            if level is not None and (str(level) not in {"1", "2", "3"}):
                raise ProviderError("所属板块的行业层级异常。")
            kind = "industry" if source_type == "行业" else (
                "theme" if str(row.get("IS_PRECISE")) == "1" else "other"
            )
            sector_id = f"eastmoney:{board_code}"
            sectors[sector_id] = StockSector(
                id=sector_id, code=board_code, name=name.strip(), kind=kind,
                source_type=source_type, level=int(level) if level is not None else None,
                reason=reason or None,
            )
        industries = [sector for sector in sectors.values() if sector.kind == "industry"]
        deepest = max((sector.level or 0 for sector in industries), default=0)
        candidates = [sector for sector in industries if (sector.level or 0) == deepest]
        primary = candidates[0] if len(candidates) == 1 else None
        return StockSectors(
            code=code, primary_sector_id=primary.id if primary else None,
            sectors=list(sectors.values()), source="eastmoney",
            source_url=("https://emweb.securities.eastmoney.com/PC_HSF10/CoreConception/Index"
                        f"?type=web&code={exchange.value.upper()}{symbol}"),
            fetched_at=datetime.now(UTC),
        )

    # --- 日线行情 ---------------------------------------------------------

    def fetch_daily_bars(self, code: str, start: date, end: date) -> list[DailyBar]:
        """区间日线 (含涨跌幅)。

        会自动向前多取 :data:`WARMUP_DAYS` 天用于计算首日涨幅, 但只返回
        ``start`` ~ ``end`` 之间的数据。
        """

        symbol = to_symbol(code)
        warm_start = start - timedelta(days=WARMUP_DAYS)
        frame = self._fetch_frame(symbol, warm_start, end)
        bars = self._to_bars(code, frame, start, end)
        if bars and bars[0].pct_chg is None and warm_start > date(1990, 1, 1):
            # 长期停牌复牌需要真正的前一次收盘价，不能用零涨幅补齐。
            frame = self._fetch_frame(symbol, date(1990, 1, 1), end)
            bars = self._to_bars(code, frame, start, end)
        return bars

    def _fetch_frame(self, symbol: str, start: date, end: date) -> pd.DataFrame:
        """优先新浪, 失败时退到腾讯。"""

        try:
            if symbol.startswith("sh689"):
                frame = self._call(
                    f"stock_zh_a_cdr_daily({symbol})", ak.stock_zh_a_cdr_daily,
                    symbol=symbol, start_date="19900101", end_date=end.strftime("%Y%m%d"),
                )
            else:
                frame = self._call(
                    f"stock_zh_a_daily({symbol})",
                    ak.stock_zh_a_daily,
                    symbol=symbol,
                    # 新浪本就下载全历史，保留复牌前的收盘价再截取目标区间。
                    start_date="19900101",
                    end_date=end.strftime("%Y%m%d"),
                    adjust="qfq",
                )
            if not isinstance(frame, pd.DataFrame) or frame.empty or "date" not in frame:
                raise ProviderError("新浪日线为空或尚未更新到请求终点")
            latest = pd.to_datetime(frame["date"], errors="coerce").max()
            if pd.isna(latest) or latest.date() < end:
                raise ProviderError("新浪日线尚未更新到请求终点")
            return frame
        except ProviderError as primary_error:
            logger.warning("新浪日线失败, 改用腾讯接口: %s", primary_error)
            frame = self._call(
                f"stock_zh_a_hist_tx({symbol})",
                ak.stock_zh_a_hist_tx,
                symbol=symbol,
                start_date="19900101",
                end_date=end.strftime("%Y%m%d"),
                adjust="qfq",
            )
            if isinstance(frame, pd.DataFrame) and "volume" not in frame and "amount" in frame:
                # 旧版 AKShare 将腾讯成交量命名为 amount；CDR 原值为股，其余为手。
                frame = frame.rename(columns={"amount": "volume"}).copy()
                frame["volume"] = pd.to_numeric(frame["volume"], errors="coerce") * (
                    1 if symbol.startswith("sh689") else 100
                )
            return frame

    def _to_bars(
        self, code: str, frame: pd.DataFrame, start: date, end: date
    ) -> list[DailyBar]:
        """把 DataFrame 转成领域对象, 并计算涨跌幅。"""

        if frame is None or len(frame) == 0:
            return []
        if not {"date", "open", "high", "low", "close", "volume"} <= set(frame):
            raise ProviderError("日线字段不完整，不能将成交额代替成交量")

        working = frame.copy()
        working["_date"] = pd.to_datetime(working["date"], errors="coerce").dt.date
        if working["_date"].isna().any() or working["_date"].duplicated().any():
            raise ProviderError("日线日期无效或重复")
        working = working.sort_values("_date").reset_index(drop=True)

        closes = working["close"].astype(float)
        pcts = closes.pct_change(fill_method=None) * 100.0
        volumes = working["volume"]

        bars: list[DailyBar] = []
        for index, row in working.loc[working["_date"].between(start, end)].iterrows():
            trade_date = row["_date"]
            pct = pcts.iloc[index]
            volume = _as_float(volumes.iloc[index])
            bars.append(
                DailyBar(
                    code=code,
                    trade_date=trade_date,
                    open=_as_float(row.get("open")),
                    high=_as_float(row.get("high")),
                    low=_as_float(row.get("low")),
                    close=_as_float(row.get("close")),
                    preclose=_as_float(closes.iloc[index - 1]) if index > 0 else None,
                    volume=None if volume is None else int(volume),
                    amount=_as_float(row.get("amount")),
                    turnover=_format_turnover(row.get("turnover")),
                    pct_chg=None if pd.isna(pct) else f"{float(pct):.4f}",
                )
            )
        return bars

    # --- 历史简称 ---------------------------------------------------------

    def fetch_name_change_history(self, code: str) -> list[str]:
        """历史简称序列 (由旧到新, 无日期)。"""

        _, symbol = split_code(code)
        frame = self._call(
            f"stock_info_change_name({symbol})",
            ak.stock_info_change_name,
            symbol=symbol,
        )
        if frame is None or len(frame) == 0 or "name" not in frame:
            return []
        return [str(value).strip() for value in frame["name"].tolist() if str(value).strip()]


def _format_turnover(value: object) -> str | None:
    """换手率统一为百分数文本 (新浪给的是小数)。"""

    number = _as_float(value)
    if number is None:
        return None
    return f"{number * 100:.4f}"
