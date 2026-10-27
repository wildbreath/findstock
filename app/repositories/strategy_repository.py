"""选股策略仓储 (条件模块组合的持久化)。"""

from __future__ import annotations

import json
import sqlite3
from datetime import UTC, datetime
from decimal import Decimal

from app.core.errors import InvalidRequestError
from app.domain.conditions import (
    CATALOG_BY_KIND,
    DEFAULT_STRATEGY,
    ConditionSpec,
    ScreenStrategy,
    validate_conditions,
)
from app.repositories.database import Database


def _now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def _parse_time(value: object) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value))
    except ValueError:  # pragma: no cover - 数据被外部改坏
        return None


def dump_conditions(conditions: tuple[ConditionSpec, ...]) -> str:
    """条件列表 → JSON 文本。"""

    return json.dumps(
        [
            {"kind": spec.kind, "params": _jsonable(spec.default_params())}
            for spec in validate_conditions(conditions)
        ],
        ensure_ascii=False,
    )


def _jsonable(params: dict[str, object]) -> dict[str, object]:
    """把 Decimal 等类型转换为 JSON 可序列化的值。"""

    converted: dict[str, object] = {}
    for key, value in params.items():
        if isinstance(value, Decimal):
            converted[key] = float(value)
        else:
            converted[key] = value
    return converted


def load_conditions(payload: str) -> tuple[ConditionSpec, ...]:
    """JSON 文本 → 条件列表 (忽略已下线的条件类型)。"""

    try:
        raw = json.loads(payload)
    except (TypeError, ValueError):  # pragma: no cover - 防御性
        return ()
    if not isinstance(raw, list):
        return ()
    conditions: list[ConditionSpec] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        kind = str(item.get("kind", ""))
        if kind not in CATALOG_BY_KIND:
            continue
        params = item.get("params")
        conditions.append(
            ConditionSpec(kind=kind, params=params if isinstance(params, dict) else {})
        )
    return tuple(conditions)


def _row_to_strategy(row: object) -> ScreenStrategy:
    return ScreenStrategy(
        name=str(row["name"]),  # type: ignore[index]
        conditions=load_conditions(str(row["conditions"])),  # type: ignore[index]
        strategy_id=int(row["id"]),  # type: ignore[index]
        builtin=bool(row["builtin"]),  # type: ignore[index]
        updated_at=_parse_time(row["updated_at"]),  # type: ignore[index]
    )


class StrategyRepository:
    """读写 ``screen_strategy`` 表。"""

    def __init__(self, database: Database) -> None:
        self._db = database
        # 首次使用即写入内置策略, 避免"先建策略后看列表"时缺少标准策略。
        self._seed_default()

    def list_all(self) -> list[ScreenStrategy]:
        """全部策略 (按名称排序); 表为空时写入内置标准策略。"""

        self._seed_default()
        with self._db.session() as conn:
            rows = conn.execute(
                "SELECT id, name, conditions, builtin, updated_at "
                "FROM screen_strategy ORDER BY builtin DESC, name"
            ).fetchall()
        return [_row_to_strategy(row) for row in rows]

    def get(self, strategy_id: int) -> ScreenStrategy | None:
        with self._db.session() as conn:
            row = conn.execute(
                "SELECT id, name, conditions, builtin, updated_at "
                "FROM screen_strategy WHERE id = ?",
                (strategy_id,),
            ).fetchone()
        return _row_to_strategy(row) if row is not None else None

    def find_by_name(self, name: str) -> ScreenStrategy | None:
        with self._db.session() as conn:
            row = conn.execute(
                "SELECT id, name, conditions, builtin, updated_at "
                "FROM screen_strategy WHERE name = ?",
                (name,),
            ).fetchone()
        return _row_to_strategy(row) if row is not None else None

    def create(
        self, name: str, conditions: tuple[ConditionSpec, ...]
    ) -> ScreenStrategy:
        """新建策略; 同名时覆盖条件 (便于"另存为同名")."""

        cleaned = name.strip()
        if not cleaned:
            raise InvalidRequestError("策略名称不能为空")
        now = _now_iso()
        with self._db.session() as conn:
            conn.execute(
                """
                INSERT INTO screen_strategy (name, conditions, builtin, created_at, updated_at)
                VALUES (?, ?, 0, ?, ?)
                ON CONFLICT(name) DO UPDATE SET
                    conditions = excluded.conditions,
                    updated_at = excluded.updated_at
                """,
                (cleaned, dump_conditions(conditions), now, now),
            )
        saved = self.find_by_name(cleaned)
        if saved is None:  # pragma: no cover - 防御性
            raise RuntimeError("策略保存失败")
        return saved

    def update(
        self,
        strategy_id: int,
        *,
        name: str | None = None,
        conditions: tuple[ConditionSpec, ...] | None = None,
    ) -> ScreenStrategy | None:
        """更新策略名称 / 条件。"""

        current = self.get(strategy_id)
        if current is None:
            return None
        new_name = (name or current.name).strip()
        if not new_name:
            raise InvalidRequestError("策略名称不能为空")
        new_conditions = current.conditions if conditions is None else conditions
        with self._db.session() as conn:
            conn.execute(
                "UPDATE screen_strategy SET name = ?, conditions = ?, updated_at = ? "
                "WHERE id = ?",
                (new_name, dump_conditions(new_conditions), _now_iso(), strategy_id),
            )
        return self.get(strategy_id)

    def delete(self, strategy_id: int) -> bool:
        with self._db.session() as conn:
            cursor = conn.execute(
                "DELETE FROM screen_strategy WHERE id = ?", (strategy_id,)
            )
        return (cursor.rowcount or 0) > 0

    def _seed_default(self) -> None:
        """首次使用时写入内置标准策略 (幂等)。"""

        try:
            with self._db.session() as conn:
                row = conn.execute(
                    "SELECT COUNT(*) AS n FROM screen_strategy"
                ).fetchone()
                if row and int(row["n"]) > 0:
                    return
                now = _now_iso()
                conn.execute(
                    "INSERT INTO screen_strategy "
                    "(name, conditions, builtin, created_at, updated_at) "
                    "VALUES (?, ?, 1, ?, ?)",
                    (
                        DEFAULT_STRATEGY.name,
                        dump_conditions(DEFAULT_STRATEGY.conditions),
                        now,
                        now,
                    ),
                )
        except sqlite3.OperationalError:  # pragma: no cover - 结构尚未初始化
            return
