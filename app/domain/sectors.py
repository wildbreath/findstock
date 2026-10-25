"""股票所属板块; ID 带数据源命名空间, 行业与题材分开。"""

from dataclasses import dataclass
from datetime import datetime
from typing import Literal


@dataclass(frozen=True, slots=True)
class StockSector:
    id: str
    code: str
    name: str
    kind: Literal["industry", "theme", "other"]
    source_type: str | None
    level: int | None
    reason: str | None


@dataclass(frozen=True, slots=True)
class StockSectors:
    code: str
    primary_sector_id: str | None
    sectors: list[StockSector]
    source: str
    source_url: str
    fetched_at: datetime
    historical: bool = False
    stale: bool = False
