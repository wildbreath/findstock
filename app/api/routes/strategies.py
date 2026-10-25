"""选股策略接口 (条件模块目录 + 策略增删改查)。"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Path, status
from pydantic import BaseModel

from app.api.deps import get_container
from app.api.presenters import to_strategy_out
from app.api.schemas import (
    StrategyCatalogResponse,
    StrategyConditionIn,
    StrategyOut,
    StrategySaveRequest,
    StrategyPreviewRequest,
)
from app.container import Container
from app.core.errors import InvalidRequestError, StockNotFoundError
from app.domain.conditions import CATALOG_BY_KIND, CONDITION_CATALOG, ConditionSpec
from app.domain.strategy_preview import build_strategy_preview

router = APIRouter(tags=["策略"])


class StrategyRemoveResponse(BaseModel):
    """删除策略的结果。"""

    id: int
    removed: bool


def _to_specs(conditions: list[StrategyConditionIn]) -> tuple[ConditionSpec, ...]:
    specs: list[ConditionSpec] = []
    for item in conditions:
        if item.kind not in CATALOG_BY_KIND:
            raise InvalidRequestError(f"未知的条件类型: {item.kind}")
        specs.append(ConditionSpec(kind=item.kind, params=dict(item.params)))
    return tuple(specs)


@router.get(
    "/strategy-catalog",
    response_model=StrategyCatalogResponse,
    summary="可用条件模块目录",
)
def get_catalog() -> StrategyCatalogResponse:
    """列出所有可用的条件模块 (前端"策略编辑器"按此渲染)。"""

    return StrategyCatalogResponse(conditions=[dict(entry) for entry in CONDITION_CATALOG])


@router.get("/strategies", response_model=list[StrategyOut], summary="策略列表")
def list_strategies(container: Container = Depends(get_container)) -> list[StrategyOut]:
    """列出全部选股策略 (首次调用会写入内置标准策略)。"""

    return [to_strategy_out(item) for item in container.strategy_repository.list_all()]


@router.post("/strategies/preview", summary="整套策略联合示例（不保存）")
def preview_strategy(payload: StrategyPreviewRequest) -> dict:
    return build_strategy_preview(_to_specs(payload.conditions))


@router.post(
    "/strategies",
    response_model=StrategyOut,
    status_code=status.HTTP_201_CREATED,
    summary="新建策略",
)
def create_strategy(
    payload: StrategySaveRequest,
    container: Container = Depends(get_container),
) -> StrategyOut:
    """新建策略 (同名策略会被覆盖为最新条件)。"""

    strategy = container.strategy_repository.create(
        payload.name, _to_specs(payload.conditions)
    )
    return to_strategy_out(strategy)


@router.put(
    "/strategies/{strategy_id}", response_model=StrategyOut, summary="更新策略"
)
def update_strategy(
    payload: StrategySaveRequest,
    strategy_id: int = Path(description="策略 id"),
    container: Container = Depends(get_container),
) -> StrategyOut:
    """更新策略的名称与条件。"""

    updated = container.strategy_repository.update(
        strategy_id, name=payload.name, conditions=_to_specs(payload.conditions)
    )
    if updated is None:
        raise StockNotFoundError(f"策略 {strategy_id} 不存在。")
    return to_strategy_out(updated)


@router.delete(
    "/strategies/{strategy_id}",
    response_model=StrategyRemoveResponse,
    summary="删除策略",
)
def delete_strategy(
    strategy_id: int = Path(description="策略 id"),
    container: Container = Depends(get_container),
) -> StrategyRemoveResponse:
    """删除策略 (全部删完后会重新写入内置标准策略)。"""

    removed = container.strategy_repository.delete(strategy_id)
    return StrategyRemoveResponse(id=strategy_id, removed=removed)
