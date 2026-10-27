"""按一个交易日填写复盘, 只读本地收盘数据, 不覆盖人工判断。"""

import re
from collections import Counter
from datetime import date, datetime
from decimal import ROUND_HALF_UP, Decimal
from uuid import uuid4

from app.core.errors import DataNotAvailableError, InvalidRequestError
from app.domain.enums import Board
from app.domain.rules import is_st_name
from app.domain.st_policy import st_price_limit
from app.domain.symbols import detect_board
from app.repositories.bar_repository import BarRepository
from app.repositories.calendar_repository import CalendarRepository
from app.repositories.database import Database
from app.repositories.ladder_repository import LadderRepository
from app.repositories.wudao_repository import WudaoRepository
from app.services.ladder_service import MARKET_TIMEZONE
from app.services.sync_engine import latest_usable_day


def update_market_cell(value: dict, pct: Decimal, item, bar, code: str, name: str) -> bool:
    text = f"{pct:+.2f}%" if pct else "0%"
    if item and item.consecutive >= 2:
        text = f"{item.consecutive}板 {text}"
    old_text, old_auto = value.get("text", ""), value.get("auto_text", "")
    protected = bool(old_text and old_text != old_auto)
    if protected:
        suffix = old_text[len(old_auto):] if old_auto and old_text.startswith(old_auto) else None
        value["text"] = text + suffix if suffix is not None and (
            not suffix[:1].isdigit() or old_auto.endswith(("%", "板"))
        ) else old_text
    else:
        value["text"] = text
    value["auto_text"] = text
    board = detect_board(code)
    limit = st_price_limit(board) if is_st_name(name) else Decimal("20" if board in (Board.GEM, Board.STAR) else "10")
    limit_down = pct <= -limit
    if (pct < 0 and bar and bar.close is not None and bar.preclose is not None
            and bar.close.is_finite() and bar.preclose.is_finite() and bar.close > 0 and bar.preclose > 0):
        # shortcut: 本地前复权价可能影响历史跌停识别，接入未复权跌停价后替换。
        limit_down = bar.close == (bar.preclose * (1 - limit / 100)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    value["background"] = (("#dc2626" if item else "#efb7b2") if pct > 0 else
                           ("#237b3b" if limit_down else "#b8d8c4") if pct < 0 else "")
    return protected


def row_theme(row: dict) -> str:
    if row.get("theme", "").strip():
        return row["theme"].strip()
    cells = [cell for _, cell in sorted(row["cells"].items()) if cell.get("text") and not re.match(
        r"^[+-]?(?:\d+(?:\.\d+)?|\.\d+)\s*%?$|^\d+板", (cell.get("auto_text") or cell["text"]).strip(),
    )]
    marked = next((cell["text"] for cell in cells if cell.get("kind") == "theme"), "")
    legacy = next((cell["text"] for cell in cells if cell.get("background", "").lower() in ("#7e22a8", "#dbeafe")), "")
    return (marked or (row.get("tracking") or {}).get("theme") or legacy).strip()


class ReviewCollectionService:
    def __init__(self, database: Database) -> None:
        self.database = database
        self.calendar = CalendarRepository(database)
        self.ladder = LadderRepository(database)
        self.themes = WudaoRepository(database)
        self.bars = BarRepository(database)

    def dates(self) -> list[str]:
        with self.database.session() as conn:
            return [row[0] for row in conn.execute(
                "SELECT trade_date FROM ladder_snapshot WHERE json_extract(payload, '$.is_final')=1 "
                "ORDER BY trade_date",
            )]

    def prepare_stock_rows(self, stocks: list[dict], theme: str, day: date) -> dict:
        usable = latest_usable_day(datetime.now(MARKET_TIMEZONE))
        if day > usable or self.calendar.is_trading_day(day) is not True:
            raise InvalidRequestError("请选择已有完整收盘数据的交易日作为加入日期。")
        previous = self.calendar.open_days_on_or_before(day, 3)
        if len(previous) < 3:
            raise InvalidRequestError("加入日期前需要两个交易日放置题材和名称，请先补充交易日历。")
        _, bar_end = self.bars.bounds()
        archived = [date.fromisoformat(value) for value in self.dates() if value <= usable.isoformat()]
        end = max([day, min(bar_end, usable) if bar_end else day, *archived])
        with self.database.session() as conn:
            count = conn.execute("SELECT COUNT(*) FROM trading_day WHERE trade_date BETWEEN ? AND ?",
                                 (day.isoformat(), end.isoformat())).fetchone()[0]
        if count != (end - day).days + 1:
            raise DataNotAvailableError("补齐区间的交易日历不完整，请先到数据页面补充。")
        days = self.calendar.open_days(day, end)
        stocks = list({stock["code"]: stock for stock in stocks}.values())
        if len(days) > 1498 or len(stocks) * (len(days) + 2) > 50000:
            raise InvalidRequestError("补齐后的格子数量过多，请缩小加入日期范围或减少股票数量。")
        codes = {stock["code"] for stock in stocks}
        bars = self.bars.load_bars_for_dates(days, sorted(codes))
        pools, unconfirmed = {}, []
        for current in days:
            stored = self.ladder.get(current)
            pools[current] = {item.code: item for item in stored.items if item.code in codes} if stored and stored.is_final else {}
            if not stored or not stored.is_final:
                unconfirmed.append(current.isoformat())
        rows, missing = [], 0
        for stock in stocks:
            code, name = stock["code"], stock["name"]
            row = {"id": uuid4().hex, "stock_code": code, "theme": theme, "tracking": {
                "code": code, "theme": theme, "entry_date": day.isoformat(), "stopped": False,
            }, "cells": {
                previous[2].isoformat(): {"text": theme, "kind": "theme", "background": "#dbeafe", "color": "#1f2937", "bold": True},
                previous[1].isoformat(): {"text": name, "kind": "stock", "background": "#2563a6", "color": "#ffffff", "bold": True},
            }}
            for current in days:
                item, bar = pools[current].get(code), bars.get(code, {}).get(current)
                pct = bar.pct_chg if bar and bar.is_normal_trading else None
                if pct is None and item and item.pct_chg is not None:
                    pct = Decimal(str(item.pct_chg))
                if pct is None or not pct.is_finite():
                    missing += 1
                    continue
                value = row["cells"].setdefault(current.isoformat(), {})
                update_market_cell(value, pct, item, bar, code, name)
            rows.append(row)
        return {"rows": rows, "dates": [previous[2].isoformat(), previous[1].isoformat(), *map(date.isoformat, days)],
                "missing_cells": missing, "unconfirmed_dates": unconfirmed}

    def fill(self, sheet: dict, day: date) -> dict:
        key = day.isoformat()
        if day > datetime.now(MARKET_TIMEZONE).date():
            raise InvalidRequestError("不能收录尚未到来的交易日。")
        if self.calendar.is_trading_day(day) is not True:
            raise InvalidRequestError("所选日期没有确认的交易日历，请先到数据页面补充。")
        collected = sheet["collected_dates"]
        if collected and key < max(collected) and key not in collected:
            raise InvalidRequestError("请按日期顺序收录；已收录的日期可以重复更新。")
        snapshots = {}

        def snapshot(value):
            if value not in snapshots:
                stored = self.ladder.get(value)
                if stored is None or not stored.is_final:
                    raise DataNotAvailableError(
                        f"缺少 {value} 的完整收盘天梯，请到数据页面下载后重试。", missing_dates=(value,),
                    )
                snapshots[value] = {item.code: item for item in stored.items}
            return snapshots[value]

        pool = snapshot(day)
        themes, _, complete = self.themes.day(day)
        if not complete:
            raise DataNotAvailableError(f"{day} 的悟道收盘题材尚未下载完整，请到数据页面补充。", missing_dates=(day,))
        previous = self.calendar.open_days_on_or_before(day, 3)
        if len(previous) < 3:
            raise InvalidRequestError("首次记录前需要两个交易日放置题材和股票名称，请先补充交易日历。")
        rows = sheet["rows"]
        start = min([previous[-1]] + [date.fromisoformat(row["tracking"]["entry_date"])
                    for row in rows if row.get("tracking")])
        with self.database.session() as conn:
            calendar_count = conn.execute(
                "SELECT COUNT(*) FROM trading_day WHERE trade_date BETWEEN ? AND ?", (start.isoformat(), key),
            ).fetchone()[0]
        if calendar_count != (day - start).days + 1:
            raise DataNotAvailableError("跟踪区间的交易日历不完整，无法准确计算分行，请先补充交易日历。")
        days = self.calendar.open_days(start, day)
        indices = {value: index for index, value in enumerate(days)}
        stopped = {row["tracking"]["code"] for row in rows if (row.get("tracking") or {}).get("stopped")}
        candidates = {code: item for code, item in pool.items() if item.consecutive >= 2
                      and item.board in ("main_sh", "main_sz") and not item.is_st and not is_st_name(item.name)
                      and (code.startswith("sh.60") or code.startswith("sz.00"))}
        resumed = 0
        for code in list(stopped & candidates.keys()):
            stop_day = max(row["tracking"].get("stopped_after") or row["tracking"]["entry_date"]
                           for row in rows if row.get("tracking") and row["tracking"]["code"] == code
                           and row["tracking"]["stopped"])
            second_board = indices[day] - candidates[code].consecutive + 2
            if second_board >= 0 and days[second_board].isoformat() > stop_day:
                for row in rows:
                    if row.get("tracking") and row["tracking"]["code"] == code:
                        row["tracking"].update(stopped=False, stopped_after=None)
                stopped.remove(code)
                resumed += 1
            else:
                del candidates[code]
        active, manual = {}, []
        for row in rows:
            tracking = row.get("tracking")
            if tracking and tracking["code"] not in stopped and tracking["entry_date"] <= key:
                if row.get("stock_code"):
                    manual.append(row)
                    continue
                old = active.get(tracking["code"])
                if old is None or old["tracking"]["entry_date"] < tracking["entry_date"]:
                    active[tracking["code"]] = row

        manual_themes = {}
        for old in sorted(rows, key=lambda value: (value.get("tracking") or {}).get("entry_date", "")):
            if old.get("stock_code"):
                continue  # 手动添加的其他题材不覆盖自动记录的归属。
            code = (old.get("tracking") or {}).get("code")
            if code and old.get("theme", "").strip():
                manual_themes[code] = old["theme"].strip()
        additions = []
        manual_codes = {row["tracking"]["code"] for row in manual}
        for code, item in candidates.items():
            row = active.get(code)
            if row is None and code in manual_codes:
                continue
            new_round = row is None
            if row is not None:
                entry = indices[date.fromisoformat(row["tracking"]["entry_date"])]
                first_board = indices[day] - item.consecutive + 1
                gap = 0
                # 只数本轮首板之前没有涨停的交易日, 跟填表频率无关。
                for prior in reversed(days[entry:max(entry, first_board)]):
                    if code in snapshot(prior):
                        break
                    gap += 1
                    if gap >= 10:
                        new_round = True
                        break
            if new_round:
                theme = manual_themes.get(code) or themes.get(code) or "未分类"
                row = {"id": uuid4().hex, "leader": False, "tracking": {
                    "code": code, "theme": theme, "entry_date": key, "stopped": False,
                }, "cells": {
                    previous[2].isoformat(): {"text": theme, "auto_text": theme, "kind": "theme",
                                             "background": "#dbeafe", "color": "#1f2937", "bold": True},
                    previous[1].isoformat(): {"text": item.name, "auto_text": item.name, "kind": "stock",
                                             "background": "#2563a6", "color": "#ffffff", "bold": True},
                }}
                if code in manual_themes:
                    row["theme"] = theme
                additions.append((row, item))
                active[code] = row

        counts = Counter(row["tracking"]["theme"] for row, _ in additions)
        def rank(item):
            return -item.consecutive, item.first_seal or "99:99:99", item.code

        additions.sort(key=lambda pair: (-counts[pair[0]["tracking"]["theme"]],
                                         pair[0]["tracking"]["theme"], rank(pair[1])))
        for row, item in additions:
            theme = row["tracking"]["theme"]
            if rows and not rows[-1].get("tracking") and not rows[-1]["cells"] and not rows[-1].get("leader"):
                rows.pop()  # 复用表尾的空白行, 保留所有已有内容和中间空行。
            matching = [index for index, old in enumerate(rows) if row_theme(old) == theme]
            occupied = [index for index, old in enumerate(rows) if old["cells"] or old.get("tracking") or old.get("leader")]
            position = matching[-1] + 1 if matching else occupied[-1] + 1 if occupied else 0
            for index in matching:
                tracking = rows[index].get("tracking")
                old_item = pool.get(tracking["code"]) if tracking else None
                if tracking and tracking["entry_date"] == key and old_item and rank(item) < rank(old_item):
                    position = index
                    break
            rows.insert(position, row)

        bars = self.bars.load_bars_for_dates([day]) if active or manual else {}
        missing, protected, updated = set(), 0, 0
        for row in [*active.values(), *manual]:
            code = row["tracking"]["code"]
            item = pool.get(code)
            bar = bars.get(code, {}).get(day)
            pct = bar.pct_chg if bar and bar.is_normal_trading else None
            if pct is None and item and item.pct_chg is not None:
                pct = Decimal(str(item.pct_chg))
            if pct is None or not pct.is_finite():
                missing.add(code)
                continue
            value = row["cells"].setdefault(key, {})
            name = item.name if item else next((cell["text"] for cell in row["cells"].values() if cell.get("kind") == "stock"), "")
            protected += update_market_cell(value, pct, item, bar, code, name)
            updated += 1

        end = max([day] + [date.fromisoformat(value) for value in sheet["dates"]])
        first = min([previous[-1]] + [date.fromisoformat(value) for value in sheet["dates"]])
        sheet["dates"] = sorted(set(sheet["dates"]) | {value.isoformat() for value in self.calendar.open_days(first, end)})
        sheet["collected_dates"] = sorted(set(collected) | {key})
        sheet["hidden_dates"] = [value for value in sheet["hidden_dates"] if value != key]
        return {"sheet": sheet, "added": len(additions), "updated": updated, "missing_codes": sorted(missing),
                "protected": protected, "stopped": len(stopped), "resumed": resumed,
                "unclassified": sum(row["tracking"]["theme"] == "未分类" for row, _ in additions)}
