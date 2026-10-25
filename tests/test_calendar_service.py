"""交易日历服务测试。"""

from __future__ import annotations

from datetime import date

import pytest

from app.container import Container
from app.core.errors import (
    CalendarNotInitializedError,
    InsufficientHistoryError,
    NotATradingDayError,
)
from tests.factories import seed

OPEN_DAYS = [
    date(2026, 9, 9),
    date(2026, 9, 10),
    date(2026, 9, 11),
    date(2026, 9, 14),
    date(2026, 9, 15),
    date(2026, 9, 16),
]
CLOSED_DAYS = [date(2026, 9, 12), date(2026, 9, 13)]


@pytest.fixture()
def seeded(container: Container) -> Container:
    seed(container, open_days=OPEN_DAYS, closed_days=CLOSED_DAYS)
    return container


def test_resolve_window_uses_trading_calendar(seeded: Container) -> None:
    """9/16 的 D0/D1/D2 必须是 9/14、9/15、9/16 (跳过周末)。"""

    window = seeded.calendar_service.resolve_window(date(2026, 9, 16))
    assert window.d0 == date(2026, 9, 14)
    assert window.d1 == date(2026, 9, 15)
    assert window.d2 == date(2026, 9, 16)
    assert window.previous_trading_day == date(2026, 9, 11)
    assert window.dates == (
        date(2026, 9, 14),
        date(2026, 9, 15),
        date(2026, 9, 16),
    )


@pytest.mark.parametrize("day", CLOSED_DAYS + [date(2026, 9, 20)])
def test_non_trading_day_is_rejected(seeded: Container, day: date) -> None:
    with pytest.raises(NotATradingDayError) as excinfo:
        seeded.calendar_service.resolve_window(day)
    assert excinfo.value.selected_date == day


def test_non_trading_day_offers_latest_complete_day(seeded: Container) -> None:
    from tests.factories import make_bar

    with seeded.database.session() as conn:
        seeded.bar_repository.upsert_bars(
            conn, [make_bar("sh.600000", date(2026, 9, 15))]
        )
        seeded.sync_repository.mark_day_synced(conn, date(2026, 9, 15), 1)

    with pytest.raises(NotATradingDayError) as excinfo:
        seeded.calendar_service.resolve_window(date(2026, 9, 13))
    assert excinfo.value.suggested_date == date(2026, 9, 15)


def test_insufficient_history(seeded: Container) -> None:
    """9/9 之前只有 0 个交易日, 无法计算 D0/D1。"""

    with pytest.raises(InsufficientHistoryError) as excinfo:
        seeded.calendar_service.resolve_window(date(2026, 9, 10))
    assert excinfo.value.available_before == 1


def test_calendar_not_initialized(container: Container) -> None:
    with pytest.raises(CalendarNotInitializedError):
        container.calendar_service.resolve_window(date(2026, 9, 16))


def test_is_trading_day(seeded: Container) -> None:
    assert seeded.calendar_service.is_trading_day(date(2026, 9, 16)) is True
    assert seeded.calendar_service.is_trading_day(date(2026, 9, 12)) is False
    assert seeded.calendar_service.is_trading_day(date(2020, 1, 1)) is None
