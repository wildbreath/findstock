"""FastAPI 依赖。"""

from __future__ import annotations

from fastapi import Request

from app.container import Container


def get_container(request: Request) -> Container:
    """从应用状态中取出依赖容器。"""

    return request.app.state.container
