"""只补连板天梯，不重新下载日线：python -m app.cli.ladder --start YYYY-MM-DD --end YYYY-MM-DD。"""

import argparse
import json
import time
from datetime import date, datetime, timedelta

from app.container import Container
from app.core.config import get_settings
from app.core.errors import FindStockError
from app.core.logging import configure_logging
from app.providers import create_provider
from app.repositories.calendar_repository import CalendarRepository
from app.services.ladder_service import HISTORY_DAYS, MARKET_TIMEZONE, LadderService
from app.services.sync_engine import latest_usable_day


def backfill(service: LadderService, start: date, end: date, *, progress=print) -> dict:
    now = datetime.now(MARKET_TIMEZONE)
    if not now.date() - timedelta(days=HISTORY_DAYS) <= start <= end <= latest_usable_day(now):
        raise ValueError("补录区间须在近一年内，且结束日期必须已经收盘。")
    calendar = service.provider.fetch_trading_calendar(start, end)
    with service.database.session() as conn:
        CalendarRepository(service.database).upsert_days(conn, calendar)
    days = sorted({day for day, is_open in calendar
                   if is_open and start <= day <= end})
    if not days:
        raise ValueError("所选区间没有可用交易日。")
    failures, added, reused = {}, [], []
    for index, day in enumerate(days):
        progress(f"[{index + 1}/{len(days)}] {day}")
        saved = service.repository.get(day)
        if saved and saved.is_final:
            reused.append(day.isoformat())
            continue
        try:
            snapshot = service.download_snapshot(day)
            stored = service.repository.get(day)
            if (not snapshot.items or not snapshot.is_final or snapshot.stale or stored is None
                    or stored.items != snapshot.items or not stored.is_final):
                raise ValueError("获取结果为空、非收盘数据或存档复查不一致")
            added.append(day.isoformat())
        except (FindStockError, ValueError) as exc:
            failures[day.isoformat()] = str(exc)
        time.sleep(0.15)
    missing = [day.isoformat() for day in days
               if (snapshot := service.repository.get(day)) is None or not snapshot.is_final]
    return {"start": start.isoformat(), "end": end.isoformat(), "checked_at": now.isoformat(),
            "expected_days": len(days), "added_dates": added, "reused_dates": reused,
            "missing_dates": missing, "failures": failures, "passed": not missing and not failures}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="补录近一年历史连板天梯，保留已有收盘存档")
    parser.add_argument("--start", type=date.fromisoformat, required=True)
    parser.add_argument("--end", type=date.fromisoformat, required=True)
    args = parser.parse_args(argv)
    settings = get_settings()
    configure_logging(settings)
    container = Container.build(settings)
    provider = create_provider(settings.provider, timeout=settings.request_timeout, max_attempts=settings.request_retries)
    service = LadderService(provider, container.database)
    stamp = datetime.now(MARKET_TIMEZONE).strftime("%Y%m%d-%H%M%S-%f")
    backup = settings.data_dir / f"ladder-before-backfill-{stamp}.json"
    with container.database.session() as conn:
        archives = [json.loads(row[0]) for row in conn.execute("SELECT payload FROM ladder_snapshot ORDER BY trade_date")]
    backup.write_text(json.dumps(archives, ensure_ascii=False), encoding="utf-8")
    try:
        report = backfill(service, args.start, args.end, progress=lambda line: print(line, flush=True))
    finally:
        provider.close()
    report["backup"] = str(backup)
    report_path = settings.data_dir / "ladder-backfill-report.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
