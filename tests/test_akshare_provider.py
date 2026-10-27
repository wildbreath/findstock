"""akshare 数据源解析测试 (不访问网络)。"""

from __future__ import annotations

from datetime import date
from typing import Any

import pandas as pd
import pytest

from app.core.errors import ProviderError
from app.providers.akshare_provider import AkshareProvider, from_symbol, to_symbol


def make_frame(rows: list[tuple[str, float, float, float, float, float]]) -> pd.DataFrame:
    """构造 akshare 风格的日线 DataFrame。"""

    return pd.DataFrame(
        [
            {
                "date": day,
                "open": open_,
                "high": high,
                "low": low,
                "close": close,
                "volume": volume,
                "amount": volume * close,
                "turnover": 0.01,
            }
            for day, open_, high, low, close, volume in rows
        ]
    )


@pytest.fixture()
def provider() -> AkshareProvider:
    return AkshareProvider(max_attempts=1, backoff_seconds=0)


def test_symbol_roundtrip() -> None:
    assert to_symbol("sh.600000") == "sh600000"
    assert to_symbol("sz.000001") == "sz000001"
    assert from_symbol("sh600000") == "sh.600000"


class TestTradingCalendar:
    def test_marks_every_calendar_day(self, provider: AkshareProvider, monkeypatch) -> None:
        monkeypatch.setattr(
            provider,
            "_load_calendar",
            lambda: [date(2026, 9, 14), date(2026, 9, 15), date(2026, 9, 16)],
        )
        days = provider.fetch_trading_calendar(date(2026, 9, 13), date(2026, 9, 17))
        assert days == [
            (date(2026, 9, 13), False),
            (date(2026, 9, 14), True),
            (date(2026, 9, 15), True),
            (date(2026, 9, 16), True),
            (date(2026, 9, 17), False),
        ]


class TestDailyBars:
    def test_long_suspension_retries_with_real_previous_close(self, provider, monkeypatch):
        starts = []

        def fetch(symbol, start, end):
            starts.append(start)
            rows = [("2026-10-19", 15, 15, 15, 15, 100)]
            if start == date(1990, 1, 1):
                rows.insert(0, ("2026-08-01", 10, 10, 10, 10, 100))
            return make_frame(rows)

        monkeypatch.setattr(provider, "_fetch_frame", fetch)
        bars = provider.fetch_daily_bars("sz.300773", date(2026, 10, 19), date(2026, 10, 19))
        assert len(starts) == 2 and starts[-1] == date(1990, 1, 1)
        assert len(bars) == 1 and bars[0].preclose == 10 and bars[0].pct_chg == "50.0000"

    @pytest.mark.parametrize("symbol, factor", [("sh600000", 100), ("sh689009", 1)])
    def test_legacy_tencent_volume_is_not_money(self, provider, monkeypatch, symbol, factor):
        raw = pd.DataFrame({"date": ["2026-10-22"], "open": [10], "high": [10],
                            "low": [10], "close": [10], "amount": [625299]})

        def call(description, *args, **kwargs):
            if "hist_tx" not in description:
                raise ProviderError("主源不可用")
            return raw

        monkeypatch.setattr(provider, "_call", call)
        frame = provider._fetch_frame(symbol, date(2026, 10, 1), date(2026, 10, 22))
        bar = provider._to_bars("sh.600000", frame, date(2026, 10, 22), date(2026, 10, 22))[0]
        assert bar.volume == 625299 * factor and bar.amount is None
        assert list(raw) == ["date", "open", "high", "low", "close", "amount"]

    def test_cdr_uses_its_native_share_volume(self, provider, monkeypatch):
        calls = []
        frame = make_frame([("2026-10-21", 38, 38, 38, 38, 10),
                            ("2026-10-22", 36, 36, 36, 36, 17495131)])
        monkeypatch.setattr(provider, "_call", lambda desc, *a, **kw: calls.append(desc) or frame)
        bars = provider.fetch_daily_bars("sh.689009", date(2026, 10, 22), date(2026, 10, 22))
        assert "stock_zh_a_cdr_daily" in calls[0]
        assert bars[0].volume == 17495131 and bars[0].amount == 17495131 * 36

    @pytest.mark.parametrize("days", [["bad-date"], ["2026-10-22", "2026-10-22"]])
    def test_rejects_invalid_or_duplicate_dates(self, provider, days):
        frame = make_frame([(day, 10, 10, 10, 10, 100) for day in days])
        with pytest.raises(ProviderError, match="日期"):
            provider._to_bars("sh.600000", frame, date(2026, 10, 1), date(2026, 10, 22))

    def test_missing_close_does_not_invent_a_zero_change(self, provider):
        frame = make_frame([("2026-10-20", 10, 10, 10, 10, 100),
                            ("2026-10-21", 10, 10, 10, float("nan"), 100),
                            ("2026-10-22", 11, 11, 11, 11, 100)])
        bars = provider._to_bars("sh.600000", frame, date(2026, 10, 21), date(2026, 10, 22))
        assert all(bar.pct_chg is None for bar in bars)

    @pytest.mark.parametrize("primary", [pd.DataFrame(), pd.DataFrame({"date": ["2026-09-14"]})])
    def test_empty_or_stale_primary_uses_backup(self, provider, monkeypatch, primary):
        backup = make_frame([("2026-09-15", 10, 10, 10, 10, 100)])
        calls = []

        def call(description, *args, **kwargs):
            calls.append(description)
            return backup if "hist_tx" in description else primary

        monkeypatch.setattr(provider, "_call", call)
        assert provider._fetch_frame("sh600000", date(2026, 9, 14), date(2026, 9, 15)) is backup
        assert len(calls) == 2 and "hist_tx" in calls[-1]

    def test_pct_is_derived_from_consecutive_closes(
        self, provider: AkshareProvider, monkeypatch
    ) -> None:
        frame = make_frame(
            [
                ("2026-09-11", 10.0, 10.2, 9.9, 10.0, 1000),
                ("2026-09-14", 10.1, 10.5, 10.0, 10.5, 3000),
                ("2026-09-15", 10.5, 11.0, 10.4, 11.0, 9000),
            ]
        )
        monkeypatch.setattr(provider, "_fetch_frame", lambda *a, **k: frame)
        bars = provider.fetch_daily_bars(
            "sh.600000", date(2026, 9, 14), date(2026, 9, 15)
        )
        assert [bar.trade_date for bar in bars] == [
            date(2026, 9, 14),
            date(2026, 9, 15),
        ]
        assert str(bars[0].pct_chg) == "5.0000"  # 10.5/10.0 - 1
        assert str(bars[1].pct_chg) == "4.7619"
        assert bars[0].volume == 3000
        assert str(bars[0].preclose) == "10.0"

    def test_warmup_day_is_used_but_not_returned(
        self, provider: AkshareProvider, monkeypatch
    ) -> None:
        captured: dict[str, Any] = {}

        def fake_frame(symbol: str, start: date, end: date) -> pd.DataFrame:
            captured["start"] = start
            return make_frame(
                [
                    ("2026-09-01", 9.0, 9.0, 9.0, 9.0, 100),
                    ("2026-09-14", 9.5, 9.5, 9.5, 9.5, 200),
                ]
            )

        monkeypatch.setattr(provider, "_fetch_frame", fake_frame)
        bars = provider.fetch_daily_bars(
            "sh.600000", date(2026, 9, 14), date(2026, 9, 14)
        )
        assert len(bars) == 1
        assert bars[0].pct_chg is not None, "首日涨幅必须能算出来"
        assert captured["start"] < date(2026, 9, 14), "必须向前多取数据"

    def test_empty_frame_returns_no_bars(
        self, provider: AkshareProvider, monkeypatch
    ) -> None:
        monkeypatch.setattr(provider, "_fetch_frame", lambda *a, **k: pd.DataFrame())
        assert provider.fetch_daily_bars("sh.600000", date(2026, 9, 14), date(2026, 9, 15)) == []

    def test_suspended_rows_are_kept_for_completeness_check(
        self, provider: AkshareProvider, monkeypatch
    ) -> None:
        """停牌或字段缺失的行要保留, 由规则层判定为数据不完整。"""

        frame = make_frame([("2026-09-14", 10.0, 10.0, 10.0, 10.0, 100)])
        frame.loc[0, "volume"] = None
        monkeypatch.setattr(provider, "_fetch_frame", lambda *a, **k: frame)
        bars = provider.fetch_daily_bars(
            "sh.600000", date(2026, 9, 14), date(2026, 9, 14)
        )
        assert bars[0].volume is None
        # akshare 不提供交易状态, 必须视为正常而不是停牌
        assert bars[0].trade_status is None
        assert bars[0].is_normal_trading is True


class TestUniverse:
    def test_filters_to_a_shares(self, provider: AkshareProvider, monkeypatch) -> None:
        frame = pd.DataFrame(
            {
                "代码": ["bj920000", "sh600000", "sz000001", "sh510300", "sh900901"],
                "名称": ["安徽凤凰", "浦发银行", "平安银行", "沪深300ETF", "B股"],
            }
        )
        monkeypatch.setattr(provider, "_call", lambda *a, **k: frame)
        snapshots = provider.fetch_stock_universe(date(2026, 9, 18))
        assert [item.code for item in snapshots] == ["sh.600000", "sz.000001"]
        assert snapshots[0].name == "浦发银行"

    def test_empty_result_raises(self, provider: AkshareProvider, monkeypatch) -> None:
        monkeypatch.setattr(
            provider, "_call", lambda *a, **k: pd.DataFrame({"代码": [], "名称": []})
        )
        with pytest.raises(ProviderError):
            provider.fetch_stock_universe(date(2026, 9, 18))


class TestNameHistory:
    def test_returns_ordered_names(self, provider: AkshareProvider, monkeypatch) -> None:
        frame = pd.DataFrame({"index": [1, 2], "name": ["海泰发展", "ST海泰"]})
        monkeypatch.setattr(provider, "_call", lambda *a, **k: frame)
        assert provider.fetch_name_change_history("sh.600082") == ["海泰发展", "ST海泰"]

    def test_propagates_failure_so_service_can_keep_cache(self, provider: AkshareProvider, monkeypatch) -> None:
        def boom(*args, **kwargs):
            raise ProviderError("上游挂了")

        monkeypatch.setattr(provider, "_call", boom)
        with pytest.raises(ProviderError):
            provider.fetch_name_change_history("sh.600082")


def test_only_confirmed_full_day_suspensions_are_exempt(provider, monkeypatch):
    frame = pd.DataFrame({
        "代码": ["600001", "000002", "300003", "600004", "900901"],
        "停牌时间": ["2026-09-14", "2026-09-15", "2026-09-14", "2026-09-16", "2026-09-14"],
        "停牌期限": ["连续停牌", "停牌1天", "盘中停牌", "连续停牌", "连续停牌"],
    })
    monkeypatch.setattr(provider, "_call", lambda *args, **kwargs: frame)
    assert provider.fetch_suspended_codes(date(2026, 9, 15)) == {"sh.600001", "sz.000002"}


def test_malformed_suspension_data_is_not_treated_as_proof(provider, monkeypatch):
    monkeypatch.setattr(provider, "_call", lambda *args, **kwargs: pd.DataFrame({"代码": ["600001"]}))
    with pytest.raises(ProviderError, match="返回格式异常"):
        provider.fetch_suspended_codes(date(2026, 9, 15))


def test_ended_suspension_is_not_an_excuse_for_a_missing_resumption_day(provider, monkeypatch):
    frame = pd.DataFrame({"代码": ["000016"], "停牌时间": ["2026-09-04"],
                          "停牌截止时间": ["2026-10-22"], "停牌期限": ["连续停牌"]})
    monkeypatch.setattr(provider, "_call", lambda *args, **kwargs: frame)
    assert provider.fetch_suspended_codes(date(2026, 10, 22)) == {"sz.000016"}
    assert provider.fetch_suspended_codes(date(2026, 10, 23)) == set()


def test_delisting_uses_official_dates_and_excludes_b_shares(provider, monkeypatch):
    def call(description, func, *, symbol):
        if symbol == "全部":
            return pd.DataFrame({"公司代码": ["601059", "601198", "900901"],
                                 "暂停上市日期": ["2026-10-19"] * 3})
        return pd.DataFrame({"证券代码": ["000001"], "终止上市日期": ["2026-10-20"]})
    monkeypatch.setattr(provider, "_call", call)
    assert provider.fetch_delisting_dates() == {
        "sh.601059": date(2026, 10, 19), "sh.601198": date(2026, 10, 19),
        "sz.000001": date(2026, 10, 20),
    }


def test_malformed_delisting_list_cannot_exempt_missing_data(provider, monkeypatch):
    monkeypatch.setattr(provider, "_call", lambda *a, **k: pd.DataFrame({"公司代码": ["601059"]}))
    with pytest.raises(ProviderError, match="名单返回格式异常"):
        provider.fetch_delisting_dates()


def test_official_listing_dates_are_parsed(provider, monkeypatch):
    def call(description, func, *, symbol):
        if symbol == "A股列表":
            return pd.DataFrame({"A股代码": ["000002"], "A股上市日期": ["1991-01-29"]})
        return pd.DataFrame({"证券代码": ["600001" if symbol == "主板A股" else "688001"],
                             "上市日期": ["2026-09-15"]})

    monkeypatch.setattr(provider, "_call", call)
    assert provider.fetch_listing_dates() == {
        "sh.600001": date(2026, 9, 15), "sh.688001": date(2026, 9, 15),
        "sz.000002": date(1991, 1, 29),
    }


def test_call_retries_then_raises(monkeypatch) -> None:
    provider = AkshareProvider(max_attempts=3, backoff_seconds=0)
    calls = {"n": 0}

    def flaky() -> str:
        calls["n"] += 1
        raise RuntimeError("boom")

    with pytest.raises(ProviderError):
        provider._call("flaky", flaky)
    assert calls["n"] == 3


def test_call_returns_on_second_attempt(monkeypatch) -> None:
    provider = AkshareProvider(max_attempts=3, backoff_seconds=0)
    calls = {"n": 0}

    def flaky() -> str:
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("first")
        return "ok"

    assert provider._call("flaky", flaky) == "ok"
    assert calls["n"] == 2
