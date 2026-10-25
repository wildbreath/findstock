"""悟道题材批量下载：100条/页、本机50次/日、逐页事务与跨日续传。"""

from __future__ import annotations

import json
import os
import threading
import time
from collections.abc import Callable
from contextlib import suppress
from datetime import UTC, date, datetime, timedelta

from app.core.config import Settings
from app.core.errors import InvalidRequestError, ProviderError, SyncAlreadyRunningError
from app.providers.wudao_provider import WudaoProvider
from app.repositories.calendar_repository import CalendarRepository
from app.repositories.database import Database
from app.repositories.meta_repository import MetaRepository
from app.repositories.sync_repository import _pid_alive
from app.services.ladder_service import MARKET_TIMEZONE

_STATE = "wudao_theme_sync:v1"
_DAILY_LIMIT = 50


class _PaginationChanged(ProviderError):
    """分页内容变化时保留原始页，下次从新批次重新核对。"""


def _now() -> datetime:
    return datetime.now(MARKET_TIMEZONE)


class WudaoThemeService:
    def __init__(self, settings: Settings, database: Database) -> None:
        self.settings = settings
        self.database = database
        self.meta = MetaRepository(database)

    def _key(self) -> str:
        configured = os.getenv("WUDAO_API_KEY", "").strip()
        if configured:
            return configured
        path = self.settings.data_dir / "wudao_api_key"
        return path.read_text(encoding="utf-8").strip() if path.exists() else ""

    def configure(self, key: str) -> dict:
        key = key.strip()
        if not key or len(key) > 512 or any(char.isspace() for char in key):
            raise InvalidRequestError("请输入有效的悟道 API Key")
        self.settings.data_dir.mkdir(parents=True, exist_ok=True)
        path = self.settings.data_dir / "wudao_api_key"
        temporary = path.with_suffix(".tmp")
        with self.database.session() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute("SELECT value FROM meta WHERE key = ?", (_STATE,)).fetchone()
            state = json.loads(row[0]) if row else {}
            if state.get("running") and _pid_alive(state.get("pid", 0)):
                raise SyncAlreadyRunningError("题材下载中，请结束后再修改密钥")
            temporary.write_text(key, encoding="utf-8")
            temporary.replace(path)
        return self.status()

    def _state(self) -> dict:
        return json.loads(self.meta.get(_STATE) or "{}")

    def _write_state(self, **fields) -> None:
        with self.database.session() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute("SELECT value FROM meta WHERE key = ?", (_STATE,)).fetchone()
            state = json.loads(row[0]) if row else {}
            state.update(fields, updated_at=datetime.now(UTC).isoformat())
            self.meta.set(conn, _STATE, json.dumps(state, ensure_ascii=False))

    def _days(self) -> list[date]:
        now = _now()
        cutoff = now.date() if (now.hour, now.minute) >= (15, 30) else now.date() - timedelta(days=1)
        with self.database.session() as conn:
            rows = conn.execute(
                "SELECT trade_date FROM ladder_snapshot WHERE trade_date <= ? ORDER BY trade_date",
                (cutoff.isoformat(),),
            ).fetchall()
        return [date.fromisoformat(row[0]) for row in rows]

    def _covered(self, conn) -> set[str]:
        return {row[0] for row in conn.execute(
            "SELECT DISTINCT r.trade_date FROM wudao_theme_row r "
            "JOIN wudao_theme_batch b ON b.id=r.batch_id WHERE b.status='complete' "
            "AND b.is_final=1",
        )}

    def _download_block_reason(self, now: datetime | None = None) -> str | None:
        now = now or _now()
        if (now.hour, now.minute) < (15, 30):
            is_open = CalendarRepository(self.database).is_trading_day(now.date())
            if is_open is not False:
                detail = "今日为交易日" if is_open else "本地尚未确认今日是否休市"
                return f"悟道题材仅在收盘后下载：{detail}，请在北京时间15:30后继续"
        if (9, 15) <= (now.hour, now.minute) < (10, 30):
            return "免费接口在北京时间09:15—10:30暂停调用，请稍后继续下载"
        return None

    def _assert_download_allowed(self, now: datetime | None = None) -> None:
        reason = self._download_block_reason(now)
        if reason:
            raise InvalidRequestError(reason)

    def status(self) -> dict:
        days = self._days()
        state = self._state()
        running = bool(state.get("running") and _pid_alive(state.get("pid", 0)))
        with self.database.session() as conn:
            covered = self._covered(conn)
        completed = sum(day.isoformat() in covered for day in days)
        usage = json.loads(self.meta.get(f"wudao_usage:{_now().date()}") or "{}")
        blocked = self._download_block_reason()
        return {
            "configured": bool(self._key()), "running": running,
            "total_days": len(days), "completed_days": completed,
            "pending_days": len(days) - completed,
            "calls_today": usage.get("calls", 0), "daily_limit": _DAILY_LIMIT,
            "message": state.get("message", "配置密钥后可下载全部本地天梯日期的悟道题材"),
            "error": state.get("error"), "updated_at": state.get("updated_at"),
            "download_allowed": blocked is None, "download_block_reason": blocked,
        }

    def _claim(self) -> None:
        self._assert_download_allowed()
        if not self._key():
            raise InvalidRequestError("尚未配置悟道 API Key，请先保存密钥")
        with self.database.session() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute("SELECT value FROM meta WHERE key = ?", (_STATE,)).fetchone()
            state = json.loads(row[0]) if row else {}
            if state.get("running") and _pid_alive(state.get("pid", 0)):
                raise SyncAlreadyRunningError("已有悟道题材下载任务正在运行")
            self.meta.set(conn, _STATE, json.dumps({
                "running": True, "pid": os.getpid(), "error": None,
                "message": "正在准备批量下载悟道题材", "updated_at": datetime.now(UTC).isoformat(),
            }, ensure_ascii=False))

    def start(self, max_calls: int = _DAILY_LIMIT) -> dict:
        self._claim()
        try:
            threading.Thread(target=self._download, args=(max_calls,), daemon=True,
                             name="wudao-themes").start()
        except Exception:
            self._write_state(running=False, error="无法启动下载任务")
            raise
        return self.status()

    def synchronize(self, max_calls: int = _DAILY_LIMIT, *, check_cancelled: Callable[[], None] | None = None) -> dict:
        self._claim()
        self._download(max_calls, check_cancelled=check_cancelled)
        return self.status()

    def _batch(self, attempted: set[date] | None = None):
        days = self._days()
        if not days:
            return None
        with self.database.session() as conn:
            # 旧盘中分页不能续成收盘存档，保留原始页并从完整新批次重新核对。
            conn.execute(
                "UPDATE wudao_theme_batch SET status='superseded' "
                "WHERE status='pending' AND (is_final<>1 OR end_date>?)",
                (days[-1].isoformat(),),
            )
            covered = self._covered(conn)
            missing = [day for day in days if day.isoformat() not in covered and day not in (attempted or set())]
            pending = conn.execute(
                "SELECT * FROM wudao_theme_batch WHERE status = 'pending' ORDER BY (end_date=?) DESC,id LIMIT 1",
                (_now().date().isoformat(),),
            ).fetchone()
            today_missing = _now().date() in missing
            if pending and (not today_missing or pending["end_date"] == _now().date().isoformat()):
                return pending
            if not missing:
                return None
            # 先补近60个交易日，再批量补更早历史；单一范围把每页100条用满。
            recent = [day for day in missing if day >= days[-min(60, len(days))]]
            selected = [_now().date()] if today_missing else recent or missing
            selected_set = set(selected)
            start_index = days.index(selected[-1])
            while start_index > 0 and days[start_index - 1] in selected_set:
                start_index -= 1
            selected = [days[start_index], selected[-1]]
            conn.execute(
                "INSERT INTO wudao_theme_batch(start_date,end_date,is_final,updated_at) VALUES (?,?,?,?)",
                (selected[0].isoformat(), selected[-1].isoformat(), 1, datetime.now(UTC).isoformat()),
            )
            return conn.execute("SELECT * FROM wudao_theme_batch WHERE id = last_insert_rowid()").fetchone()

    def _reserve_call(self) -> str:
        self._assert_download_allowed()
        usage = json.loads(self.meta.get(f"wudao_usage:{_now().date()}") or "{}")
        delay = max(0, usage.get("last_at", 0) + 2.1 - time.time())
        if delay:
            time.sleep(delay)
        # 限频等待可能跨过零点或交易时段，按真正发送时刻再次核对。
        now = _now()
        self._assert_download_allowed(now)
        key = f"wudao_usage:{now.date()}"
        with self.database.session() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
            usage = json.loads(row[0]) if row else {}
            if usage.get("calls", 0) >= _DAILY_LIMIT:
                raise ProviderError("本机今日50次额度已用完，已保存进度，次日可继续下载")
            # 超时也可能已在源端计费，预先扣本机预算且不自动重试。
            self.meta.set(conn, key, json.dumps({"calls": usage.get("calls", 0) + 1,
                                               "last_at": time.time()}))
        return key

    def _release_unsent_call(self, key: str) -> None:
        with self.database.session() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
            usage = json.loads(row[0]) if row else {}
            usage["calls"] = max(0, usage.get("calls", 0) - 1)
            self.meta.set(conn, key, json.dumps(usage))

    def _save_page(self, batch, page) -> None:
        fetched_at = datetime.now(UTC).isoformat()
        with self.database.session() as conn:
            conn.execute("BEGIN IMMEDIATE")
            if page.page != batch["next_page"] or page.page_size != 100:
                raise ProviderError("悟道返回页码或每页数量与请求不一致，未推进下载进度")
            if batch["total"] is not None and (page.total != batch["total"] or page.total_pages != batch["total_pages"]):
                raise _PaginationChanged("悟道分页总数发生变化，已保留原始页；下次下载将重新核对该范围")
            if page.total == 0:
                raise ProviderError("本地有涨停存档，但悟道返回空结果，未标记题材下载完成")
            expected = min(100, page.total - (page.page - 1) * 100)
            if len(page.rows) != expected:
                raise ProviderError("悟道返回数量不足，可能被截断，未标记下载完成")
            for row in page.rows:
                raw_code = row["code"]
                code = f"{'sh' if raw_code.startswith('6') else 'sz' if raw_code.startswith(('0', '3')) else 'bj'}.{raw_code}"
                trade_date = date.fromisoformat(row["date"])
                if conn.execute(
                    "SELECT 1 FROM wudao_theme_row WHERE batch_id=? AND trade_date=? AND code=?",
                    (batch["id"], trade_date.isoformat(), code),
                ).fetchone():
                    raise _PaginationChanged("悟道跨页出现重复股票日，已保留原始页；下次下载将重新核对该范围")
                conn.execute(
                    "INSERT INTO wudao_theme_row VALUES (?,?,?,?,?,?)",
                    (batch["id"], trade_date.isoformat(), code, (row["primaryTheme"] or "").strip() or None,
                     json.dumps(row, ensure_ascii=False), fetched_at),
                )
            conn.execute("INSERT INTO wudao_theme_page VALUES (?,?,?,?)",
                         (batch["id"], page.page, json.dumps(page.raw, ensure_ascii=False), fetched_at))
            final = page.page == page.total_pages
            conn.execute(
                "UPDATE wudao_theme_batch SET next_page=?, total=?, total_pages=?, status=?, is_final=?, updated_at=? WHERE id=?",
                (page.page + 1, page.total, page.total_pages, "complete" if final else "pending",
                 batch["is_final"], fetched_at, batch["id"]),
            )

    def _download(self, max_calls: int, *, check_cancelled: Callable[[], None] | None = None) -> None:
        calls = 0
        error = None
        provider = None
        attempted: set[date] = set()
        try:
            if not 1 <= max_calls <= _DAILY_LIMIT:
                raise InvalidRequestError("单次任务调用上限必须在1到50之间")
            self._assert_download_allowed()
            provider = WudaoProvider(self._key(), timeout=self.settings.request_timeout)
            provider.before_query = self._assert_download_allowed
            while calls < max_calls:
                self._assert_download_allowed()
                if check_cancelled is not None:
                    check_cancelled()
                batch = self._batch(attempted)
                if batch is None:
                    break
                reserved = self._reserve_call()
                try:
                    if check_cancelled is not None:
                        check_cancelled()
                    self._write_state(message=f"正在下载 {batch['start_date']} 至 {batch['end_date']} 第{batch['next_page']}页，每页100条；本次第{calls + 1}次调用")
                    self._assert_download_allowed()
                except Exception:
                    self._release_unsent_call(reserved)
                    raise
                calls += 1
                try:
                    page = provider.fetch_page(date.fromisoformat(batch["start_date"]),
                                               date.fromisoformat(batch["end_date"]), batch["next_page"])
                except InvalidRequestError:
                    self._release_unsent_call(reserved)
                    raise
                try:
                    self._save_page(batch, page)
                    if page.page == page.total_pages:
                        attempted.update(day for day in self._days()
                                         if batch["start_date"] <= day.isoformat() <= batch["end_date"])
                except _PaginationChanged:
                    with self.database.session() as conn:
                        conn.execute("UPDATE wudao_theme_batch SET status='superseded' WHERE id=?", (batch["id"],))
                    raise
        except (ProviderError, InvalidRequestError) as exc:
            error = str(exc)
        except Exception:
            error = "题材下载失败，已保留成功页和续传进度，请检查接口后重试"
        finally:
            if provider is not None:
                with suppress(Exception):
                    provider.close()
            status = self.status()
            if error:
                message = error
            elif status["pending_days"]:
                message = f"本次调用{calls}次，尚有{status['pending_days']}日待补，已保存进度，可继续下载"
            else:
                message = f"题材来源数据已全部存入本地，本次调用{calls}次；未匹配的股票会单独显示未获取"
            self._write_state(running=False, error=error, message=message)
