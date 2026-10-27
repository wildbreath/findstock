"""数据源失败不能清除过期但有效的名称缓存。"""

from datetime import UTC, datetime, timedelta

from app.core.errors import ProviderError
from app.providers.akshare_provider import AkshareProvider
from app.services.name_history_service import NameHistoryService


def test_network_failure_keeps_old_cache_and_fetch_timestamp(container, monkeypatch):
    code = "sh.600001"
    names = ["*ST旧名", "普通股份"]
    fetched_at = datetime.now(UTC).replace(microsecond=0) - timedelta(days=4)
    with container.database.session() as conn:
        container.stock_repository.save_name_changes(conn, code, names, fetched_at=fetched_at)
    provider = AkshareProvider(max_attempts=1)

    def fail(*args, **kwargs):
        raise ProviderError("网络暂不可用")

    monkeypatch.setattr(provider, "_call", fail)
    service = NameHistoryService(container.database, container.stock_repository, lambda: provider)
    assert service.history_for(code) == names
    assert container.stock_repository.load_name_changes(code) == names
    assert container.stock_repository.name_change_fetched_at(code) == fetched_at
