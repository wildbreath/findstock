"""端到端冒烟脚本: 下载指定日期的数据并执行一次筛选。

用法::

    python -m scripts.verify_pipeline --date 2026-09-16
    python -m scripts.verify_pipeline --date 2026-09-16 --no-download

该脚本用于安装后的自检: 它会真实访问数据源, 因此需要联网。
"""

from __future__ import annotations

import argparse
import sys
import time
from datetime import date

from app.container import Container
from app.core.config import get_settings
from app.core.logging import configure_logging
from app.domain.enums import SyncMode

POLL_INTERVAL_SECONDS = 5
DEFAULT_TIMEOUT_MINUTES = 40


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    """解析参数。"""

    parser = argparse.ArgumentParser(description="沪深A股筛选系统端到端自检")
    parser.add_argument("--date", required=True, help="待筛选的交易日 (yyyy-mm-dd)")
    parser.add_argument(
        "--no-download",
        action="store_true",
        help="跳过数据下载, 仅使用本地已有数据执行筛选",
    )
    parser.add_argument(
        "--timeout-minutes",
        type=int,
        default=DEFAULT_TIMEOUT_MINUTES,
        help="等待下载完成的最长时间",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    """执行自检。"""

    args = parse_args(argv)
    target = date.fromisoformat(args.date)
    settings = get_settings()
    configure_logging(settings)
    container = Container.build(settings)
    service = container.data_sync_service

    print("== 1. 交易日历 ==", flush=True)
    started = time.time()
    trading_days = service.ensure_calendar()
    print(
        f"   交易日 {trading_days} 天 (耗时 {time.time() - started:.1f}s)", flush=True
    )

    if not args.no_download:
        window = container.calendar_service.resolve_window(target)
        dates = list(window.dates)
        print(f"== 2. 下载 {dates} ==", flush=True)
        progress = service.start_sync(SyncMode.TARGETED, target_dates=dates)
        deadline = time.time() + args.timeout_minutes * 60
        last = ""
        while time.time() < deadline:
            time.sleep(POLL_INTERVAL_SECONDS)
            current = service.progress(progress.run_id)
            if current is None:
                break
            line = (
                f"   {current.status.value} {current.phase} "
                f"{current.done_stocks}/{current.total_stocks} {current.percent}%"
            )
            if line != last:
                print(line, flush=True)
                last = line
            if not current.is_running:
                print(
                    f"   结束: {current.status.value} "
                    f"message={current.message} error={current.error}",
                    flush=True,
                )
                break

    coverage = service.coverage()
    print(
        f"== 3. 本地覆盖: {coverage.bar_count} 条日线 / {coverage.stock_count} 只股票 / "
        f"{coverage.complete_days} 个完整交易日 / "
        f"{coverage.bar_start} ~ {coverage.bar_end}",
        flush=True,
    )

    print(f"== 4. 筛选 {target} ==", flush=True)
    result = container.screener_service.screen(target)
    print(
        f"   实际交易日 D0={result.window.d0} D1={result.window.d1} "
        f"D2={result.window.d2}",
        flush=True,
    )
    print(f"   漏斗={result.funnel}", flush=True)
    print(f"   命中 {result.hit_count} 只", flush=True)
    for hit in result.hits:
        print(
            f"   {hit.code} {hit.name} | "
            f"D0 {hit.d0_bar.pct_chg}% {hit.d0_bar.volume} | "
            f"D1 {hit.d1_bar.pct_chg}% {hit.d1_bar.volume} | "
            f"D2 {hit.d2_bar.pct_chg}% {hit.d2_bar.volume} | "
            f"量比 {hit.first_volume_ratio} / {hit.second_volume_ratio}",
            flush=True,
        )
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
