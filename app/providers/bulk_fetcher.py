"""并发批量抓取器。

akshare 底层是 HTTP 请求, 线程安全, 因此用线程池并发即可 —— 不需要像
单 socket 协议的客户端那样开多进程。所有线程共享同一个数据源实例,
只有主线程负责产出的批次, 落库仍然由调用方串行完成。
"""

from __future__ import annotations

import logging
import time
from collections.abc import Iterator, Sequence
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from dataclasses import dataclass
from datetime import date

from app.domain.models import DailyBar
from app.providers.base import MarketDataProvider

logger = logging.getLogger(__name__)

_FETCH_TIMEOUT_SECONDS = 180.0

#: 只要还有股票在完成就一直等; 连续这么久一只都没完成, 就放弃剩余股票。
DEFAULT_STALL_TIMEOUT = 150.0


@dataclass(frozen=True, slots=True)
class FetchChunkResult:
    """一个落库批次的结果。"""

    requested: tuple[str, ...]
    bars: tuple[DailyBar, ...]
    errors: tuple[tuple[str, str], ...]

    @property
    def failed_codes(self) -> tuple[str, ...]:
        return tuple(code for code, _ in self.errors)


def chunked(items: Sequence[str], size: int) -> list[list[str]]:
    """把代码列表切成固定大小的批次。"""

    if size <= 0:
        raise ValueError("批次大小必须为正整数")
    return [list(items[i : i + size]) for i in range(0, len(items), size)]


class BulkFetcher:
    """并发抓取日线, 每凑满一批就产出一次, 便于边抓边落库与显示进度。"""

    def __init__(
        self,
        provider: MarketDataProvider,
        *,
        workers: int = 8,
        chunk_size: int = 40,
        max_retries: int = 1,
        stall_timeout: float = DEFAULT_STALL_TIMEOUT,
    ) -> None:
        if workers < 1:
            raise ValueError("workers 必须 >= 1")
        self._provider = provider
        self._workers = workers
        self._chunk_size = chunk_size
        self._max_retries = max(0, max_retries)
        self._stall_timeout = max(1.0, stall_timeout)

    def fetch(
        self, codes: Sequence[str], start: date, end: date
    ) -> Iterator[FetchChunkResult]:
        """按 ``chunk_size`` 逐个批次产出结果。"""

        codes = list(codes)
        if not codes:
            return

        if self._workers == 1:
            yield from self._fetch_sequential(codes, start, end)
            return

        buffer_codes: list[str] = []
        buffer_bars: list[DailyBar] = []
        buffer_errors: list[tuple[str, str]] = []

        pool = ThreadPoolExecutor(
            max_workers=self._workers, thread_name_prefix="findstock-fetch"
        )
        futures = {pool.submit(self._fetch_one, code, start, end): code for code in codes}
        pending = set(futures)
        try:
            while pending:
                done, pending = wait(
                    pending, timeout=self._stall_timeout, return_when=FIRST_COMPLETED
                )
                if not done:
                    # 连续几分钟一只都没完成, 说明上游把这些请求挂住了。
                    # 放弃等待并如实记为失败, 保证整批任务能正常收尾。
                    logger.warning(
                        "%d 只股票超过 %.0fs 无任何进展, 放弃等待",
                        len(pending),
                        self._stall_timeout,
                    )
                    for future in pending:
                        code = futures[future]
                        buffer_codes.append(code)
                        buffer_errors.append(
                            (code, f"上游超过 {self._stall_timeout:.0f}s 无响应")
                        )
                    pending = set()
                    break

                for future in done:
                    code = futures[future]
                    try:
                        bars, error = future.result(timeout=_FETCH_TIMEOUT_SECONDS)
                    except Exception as exc:  # noqa: BLE001 - 兜住线程内任何异常
                        bars, error = [], f"{type(exc).__name__}: {exc}"

                    buffer_codes.append(code)
                    if error:
                        buffer_errors.append((code, error))
                    else:
                        buffer_bars.extend(bars)

                    if len(buffer_codes) >= self._chunk_size:
                        yield FetchChunkResult(
                            tuple(buffer_codes),
                            tuple(buffer_bars),
                            tuple(buffer_errors),
                        )
                        buffer_codes, buffer_bars, buffer_errors = [], [], []
        finally:
            # 不能用 with: 默认的 shutdown(wait=True) 会一直等待被上游挂住的线程。
            pool.shutdown(wait=False, cancel_futures=True)

        if buffer_codes:
            yield FetchChunkResult(
                tuple(buffer_codes), tuple(buffer_bars), tuple(buffer_errors)
            )

    def _fetch_sequential(
        self, codes: Sequence[str], start: date, end: date
    ) -> Iterator[FetchChunkResult]:
        buffer_codes: list[str] = []
        buffer_bars: list[DailyBar] = []
        buffer_errors: list[tuple[str, str]] = []

        for code in codes:
            bars, error = self._fetch_one(code, start, end)
            buffer_codes.append(code)
            if error:
                buffer_errors.append((code, error))
            else:
                buffer_bars.extend(bars)
            if len(buffer_codes) >= self._chunk_size:
                yield FetchChunkResult(
                    tuple(buffer_codes), tuple(buffer_bars), tuple(buffer_errors)
                )
                buffer_codes, buffer_bars, buffer_errors = [], [], []

        if buffer_codes:
            yield FetchChunkResult(
                tuple(buffer_codes), tuple(buffer_bars), tuple(buffer_errors)
            )

    def _fetch_one(
        self, code: str, start: date, end: date
    ) -> tuple[list[DailyBar], str | None]:
        """抓取单只股票; 失败时按 ``max_retries`` 重试。"""

        last_error: str | None = None
        for attempt in range(self._max_retries + 1):
            try:
                bars = self._provider.fetch_daily_bars(code, start, end)
                keys = [(bar.code, bar.trade_date) for bar in bars]
                if len(keys) != len(set(keys)) or any(
                    bar.code != code or not start <= bar.trade_date <= end for bar in bars
                ):
                    raise ValueError("日线返回了重复、其他股票或区间外的数据")
                return bars, None
            except Exception as exc:  # noqa: BLE001 - 需要兜住数据源的所有异常
                last_error = f"{type(exc).__name__}: {exc}"
                logger.warning("抓取 %s 失败 (第 %d 次): %s", code, attempt + 1, last_error)
                if attempt < self._max_retries:
                    time.sleep(0.5 * (attempt + 1))
        return [], last_error
