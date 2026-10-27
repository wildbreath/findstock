"""板块代码、主行业选择、缓存时间口径及接口。"""

from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from threading import Event
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app.api.deps import get_container
from app.core.errors import ProviderError
from app.domain.sectors import StockSector, StockSectors
from app.main import create_app
from app.providers import akshare_provider
from app.providers.akshare_provider import AkshareProvider
from app.services.stock_sector_service import StockSectorService

CODE = "sz.002696"


def profile():
    return StockSectors(
        code=CODE, primary_sector_id="eastmoney:BK1509",
        sectors=[StockSector("eastmoney:BK1509", "BK1509", "水产饲料", "industry", "行业", 3, None)],
        source="eastmoney", source_url="https://emweb.securities.eastmoney.com/",
        fetched_at=datetime.now(UTC),
    )


@pytest.fixture()
def upstream(monkeypatch):
    rows = [
        {"SECURITY_CODE": "002696", "NEW_BOARD_CODE": "BK0967", "BOARD_NAME": "水产概念", "IS_PRECISE": "1", "SELECTED_BOARD_REASON": "公司公开业务资料"},
        {"SECURITY_CODE": "002696", "NEW_BOARD_CODE": "BK1509", "BOARD_NAME": "水产饲料", "BOARD_TYPE": "行业", "BOARD_LEVEL": "3"},
        {"SECURITY_CODE": "002696", "NEW_BOARD_CODE": "BK0433", "BOARD_NAME": "农林牧渔", "BOARD_TYPE": "行业", "BOARD_LEVEL": "1"},
        {"SECURITY_CODE": "002696", "NEW_BOARD_CODE": "BK0154", "BOARD_NAME": "广西板块", "BOARD_TYPE": "板块"},
    ]
    payload = {"result": {"pages": 1, "data": rows}}
    calls = []

    def get(url, **kwargs):
        calls.append(dict(kwargs["params"]))
        return SimpleNamespace(raise_for_status=lambda: None, json=lambda: payload)

    monkeypatch.setattr(akshare_provider.requests, "get", get)
    return rows, payload, calls, AkshareProvider(max_attempts=1)


def test_provider_uses_deepest_industry_and_real_ids(upstream):
    rows, _, calls, provider = upstream
    result = provider.fetch_stock_sectors(CODE)
    assert result.primary_sector_id == "eastmoney:BK1509"
    assert [s.kind for s in result.sectors] == ["theme", "industry", "industry", "other"]
    assert result.sectors[0].reason == "公司公开业务资料"
    assert not result.historical and result.fetched_at.tzinfo is not None
    assert "SZ002696" in result.source_url
    assert calls[0]["filter"] == '(SECURITY_CODE="002696")'
    rows[1]["BOARD_NAME"] = "更新后的行业名"
    assert provider.fetch_stock_sectors(CODE).primary_sector_id == result.primary_sector_id


def test_provider_never_promotes_concepts_to_primary_industry(upstream):
    rows, _, _, provider = upstream
    rows[:] = rows[:1]
    result = provider.fetch_stock_sectors(CODE)
    assert result.primary_sector_id is None
    assert result.sectors[0].kind == "theme"


def test_multiple_deepest_industries_are_not_arbitrarily_ranked(upstream):
    rows, _, _, provider = upstream
    rows.append(dict(rows[1], NEW_BOARD_CODE="BK1510", BOARD_NAME="另一行业"))
    result = provider.fetch_stock_sectors(CODE)
    assert result.primary_sector_id is None
    assert len([s for s in result.sectors if s.kind == "industry" and s.level == 3]) == 2


@pytest.mark.parametrize("field,value", [
    ("SECURITY_CODE", "600000"), ("NEW_BOARD_CODE", "invalid"),
    ("BOARD_NAME", ""), ("BOARD_LEVEL", "bad"),
])
def test_provider_rejects_invalid_source_rows(upstream, field, value):
    rows, _, _, provider = upstream
    rows[0][field] = value
    with pytest.raises(ProviderError):
        provider.fetch_stock_sectors(CODE)


def test_provider_missing_payload_and_duplicate_members(upstream):
    rows, payload, _, provider = upstream
    rows.append(dict(rows[0]))
    assert len(provider.fetch_stock_sectors(CODE).sectors) == 4
    payload["result"] = None
    with pytest.raises(ProviderError):
        provider.fetch_stock_sectors(CODE)


def test_provider_follows_pagination(upstream):
    _, payload, calls, provider = upstream
    payload["result"]["pages"] = 2
    assert len(provider.fetch_stock_sectors(CODE).sectors) == 4
    assert [call["pageNumber"] for call in calls] == [1, 2]


@pytest.fixture()
def service(container):
    calls = []

    def fetch(code):
        calls.append(code)
        return profile()

    return StockSectorService(SimpleNamespace(fetch_stock_sectors=fetch), container.database), calls


def test_service_persists_cache_and_refreshes(service):
    sectors, calls = service
    first = sectors.get(CODE)
    assert sectors.get(CODE) == first
    restarted = StockSectorService(sectors.provider, sectors.database)
    assert restarted.get(CODE) == first
    assert calls == [CODE]
    restarted.get(CODE, refresh=True)
    assert calls == [CODE, CODE]


def test_expired_cache_is_marked_stale_on_upstream_failure(service):
    sectors, _ = service
    sectors.provider.fetch_stock_sectors = lambda code: replace(profile(), fetched_at=datetime.now(UTC) - timedelta(days=2))
    old = sectors.get(CODE)

    def fail(code):
        raise ProviderError("板块源暂不可用")

    sectors.provider.fetch_stock_sectors = fail
    result = sectors.get(CODE)
    assert result.stale and result.fetched_at == old.fetched_at
    assert result.primary_sector_id == old.primary_sector_id


def test_corrupt_cache_does_not_block_refresh(service):
    sectors, calls = service
    with sectors.database.session() as conn:
        sectors.meta.set(conn, f"stock_sectors:v1:{CODE}", "not json")
    assert sectors.get(CODE).primary_sector_id == "eastmoney:BK1509"
    assert calls == [CODE]


@pytest.mark.parametrize("fails", [False, True])
@pytest.mark.parametrize("refresh", [False, True])
def test_concurrent_requests_share_result_and_can_retry(service, monkeypatch, fails, refresh):
    sectors, calls = service
    started, joined, release = Event(), Event(), Event()
    read = sectors.meta.get

    def read_cache(key):
        raw = read(key)
        if started.is_set():
            joined.set()
        return raw

    def fetch(code):
        calls.append(code)
        started.set()
        assert release.wait(5)
        if fails:
            raise ProviderError("板块源暂不可用")
        return profile()

    monkeypatch.setattr(sectors.meta, "get", read_cache)
    sectors.provider.fetch_stock_sectors = fetch
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(sectors.get, CODE, refresh=refresh)
        try:
            assert started.wait(5)
            second = pool.submit(sectors.get, CODE, refresh=refresh)
            assert joined.wait(5)
        finally:
            release.set()
        if fails:
            for result in (first, second):
                with pytest.raises(ProviderError):
                    result.result(timeout=5)
        else:
            assert first.result(timeout=5) == second.result(timeout=5)
    assert calls == [CODE]
    sectors.provider.fetch_stock_sectors = lambda code: profile()
    assert sectors.get(CODE, refresh=True).code == CODE


def test_slow_stock_does_not_block_other_fetches_or_cached_stocks(service):
    sectors, calls = service
    cached_code, other_code = "sh.600000", "sz.000001"
    sectors.provider.fetch_stock_sectors = lambda code: replace(profile(), code=code)
    cached = sectors.get(cached_code)
    started, release = Event(), Event()

    def fetch(code):
        calls.append(code)
        if code == CODE:
            started.set()
            assert release.wait(5)
        return replace(profile(), code=code)

    sectors.provider.fetch_stock_sectors = fetch
    with ThreadPoolExecutor(max_workers=3) as pool:
        slow = pool.submit(sectors.get, CODE)
        try:
            assert started.wait(5)
            hit = pool.submit(sectors.get, cached_code)
            other = pool.submit(sectors.get, other_code)
            assert hit.result(timeout=2) == cached
            assert other.result(timeout=2).code == other_code
        finally:
            release.set()
        assert slow.result(timeout=5).code == CODE
    assert calls == [CODE, other_code]


def test_api_contract_and_failures(container, service):
    sectors, calls = service
    app = create_app()
    container.stock_sector_service = sectors
    app.dependency_overrides[get_container] = lambda: container
    client = TestClient(app, client=("127.0.0.1", 50000))
    data = client.get(f"/api/stocks/{CODE}/sectors").json()
    assert data["primary_sector_id"] == "eastmoney:BK1509"
    assert data["sectors"][0]["level"] == 3
    assert data["historical"] is False and data["source"] == "eastmoney"
    assert client.get(f"/api/stocks/{CODE}/sectors?refresh=true").status_code == 200
    assert calls == [CODE, CODE]
    assert client.get("/api/stocks/invalid/sectors").status_code == 422
    assert client.get("/api/stocks/sh.900001/sectors").status_code == 422

    def fail(code):
        raise ProviderError("板块源暂不可用")

    sectors.provider.fetch_stock_sectors = fail
    assert client.get("/api/stocks/sh.600000/sectors").status_code == 502
    assert client.get(f"/api/stocks/{CODE}/sectors?refresh=true").json()["stale"] is True
