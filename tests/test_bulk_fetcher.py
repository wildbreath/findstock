"""并发抓取器测试 (不访问网络)。"""

from __future__ import annotations

import threading
import time
from datetime import date

import pytest

from app.domain.models import DailyBar
from app.providers.bulk_fetcher import BulkFetcher, chunked
from tests.factories import make_bar

DAY = date(2026, 9, 16)


class FakeProvider:
    """记录调用情况的假数据源。"""

    name = "fake"

    def __init__(self, *, fail_on: set[str] | None = None) -> None:
        self.calls: list[str] = []
        self._fail_on = fail_on or set()

    def open(self) -> None:
        pass

    def close(self) -> None:
        pass

    def fetch_daily_bars(self, code: str, start: date, end: date) -> list[DailyBar]:
        self.calls.append(code)
        if code in self._fail_on:
            raise RuntimeError("boom")
        return [make_bar(code, DAY)]


def test_chunked() -> None:
    assert chunked(["a", "b", "c", "d", "e"], 2) == [["a", "b"], ["c", "d"], ["e"]]
    with pytest.raises(ValueError):
        chunked(["a"], 0)


@pytest.mark.parametrize("workers", [1, 4])
def test_every_code_is_fetched_exactly_once(workers: int) -> None:
    provider = FakeProvider()
    fetcher = BulkFetcher(provider, workers=workers, chunk_size=3)
    codes = [f"sh.6000{n:02d}" for n in range(11)]

    chunks = list(fetcher.fetch(codes, DAY, DAY))

    yielded = [code for chunk in chunks for code in chunk.requested]
    assert sorted(yielded) == sorted(codes)
    assert sorted(provider.calls) == sorted(codes)
    assert all(not chunk.errors for chunk in chunks)
    assert sum(len(chunk.bars) for chunk in chunks) == len(codes)


@pytest.mark.parametrize("workers", [1, 4])
def test_failures_are_reported_not_raised(workers: int) -> None:
    provider = FakeProvider(fail_on={"sh.600001"})
    fetcher = BulkFetcher(provider, workers=workers, chunk_size=2, max_retries=0)

    chunks = list(fetcher.fetch(["sh.600000", "sh.600001", "sh.600002"], DAY, DAY))

    failed = [code for chunk in chunks for code in chunk.failed_codes]
    assert failed == ["sh.600001"]
    assert sum(len(chunk.bars) for chunk in chunks) == 2


def test_retry_succeeds_on_second_attempt() -> None:
    class Flaky(FakeProvider):
        def __init__(self) -> None:
            super().__init__()
            self.attempts = 0

        def fetch_daily_bars(self, code: str, start: date, end: date) -> list[DailyBar]:
            self.attempts += 1
            if self.attempts == 1:
                raise RuntimeError("first")
            return [make_bar(code, DAY)]

    provider = Flaky()
    fetcher = BulkFetcher(provider, workers=1, chunk_size=1, max_retries=1)
    chunks = list(fetcher.fetch(["sh.600000"], DAY, DAY))

    assert chunks[0].errors == ()
    assert len(chunks[0].bars) == 1
    assert provider.attempts == 2


def test_empty_input_yields_nothing() -> None:
    fetcher = BulkFetcher(FakeProvider(), workers=2, chunk_size=5)
    assert list(fetcher.fetch([], DAY, DAY)) == []


@pytest.mark.parametrize("kind", ["wrong_code", "wrong_date", "duplicate"])
def test_invalid_response_identity_is_reported_as_failure(kind: str) -> None:
    class Invalid(FakeProvider):
        def fetch_daily_bars(self, code, start, end):
            if kind == "wrong_code":
                return [make_bar("sz.000001", DAY)]
            if kind == "wrong_date":
                return [make_bar(code, date(2026, 9, 17))]
            return [make_bar(code, DAY), make_bar(code, DAY)]

    result = list(BulkFetcher(Invalid(), workers=1, max_retries=0).fetch(["sh.600000"], DAY, DAY))[0]
    assert result.bars == ()
    assert result.failed_codes == ("sh.600000",)


def test_invalid_workers_rejected() -> None:
    with pytest.raises(ValueError):
        BulkFetcher(FakeProvider(), workers=0)


class HangingProvider(FakeProvider):
    """模拟被上游挂住的请求: 永远不返回。"""

    def __init__(self) -> None:
        super().__init__()
        self.release = threading.Event()

    def fetch_daily_bars(self, code: str, start: date, end: date) -> list[DailyBar]:
        self.calls.append(code)
        self.release.wait(timeout=30)
        return [make_bar(code, DAY)]


def test_stalled_requests_are_abandoned_not_waited_forever() -> None:
    """上游挂住时必须放弃等待并记为失败, 而不是让整批任务卡死。"""

    provider = HangingProvider()
    fetcher = BulkFetcher(provider, workers=2, chunk_size=10, stall_timeout=0.5)

    started = time.monotonic()
    chunks = list(fetcher.fetch(["sh.600000", "sh.600001", "sh.600002"], DAY, DAY))
    elapsed = time.monotonic() - started

    assert elapsed < 10, "不应该等待被挂住的请求"
    failed = [code for chunk in chunks for code in chunk.failed_codes]
    assert sorted(failed) == ["sh.600000", "sh.600001", "sh.600002"]
    provider.release.set()
