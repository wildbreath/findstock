"""FastAPI 应用入口。"""

from __future__ import annotations

import logging
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles

from app import __version__
from app.api.error_handlers import register_error_handlers
from app.api.routes import api_router
from app.container import Container
from app.core.config import get_settings
from app.core.logging import configure_logging

logger = logging.getLogger(__name__)

#: 前端页面路径 (静态资源统一走 /static/ 前缀); 这些响应都要求每次回源校验。
FRONTEND_PAGES = {
    "/": "overview.html",
    "/screen": "index.html",
    "/screen/stocks": "index.html",
    "/screen/strategies": "strategy.html",
    "/strategy": "strategy.html",
    "/data": "data.html",
    "/watchlist": "watchlist.html",
    "/stock-ladder": "ladder.html",
    "/multi-chart": "multi-chart.html",
    "/review": "review.html",
}


def create_app() -> FastAPI:
    """构建 FastAPI 应用 (工厂函数, 便于测试)。"""

    settings = get_settings()
    configure_logging(settings)
    container = Container.build(settings)

    app = FastAPI(
        title="沪深A股自动筛选系统",
        description=(
            "按用户选择的交易日, 自动筛选同时满足 "
            "连续两次成交量翻倍 (>2)、连续三日涨幅均落在 (0%, 7%)、"
            "且 D2 非 ST 的沪深A股。"
        ),
        version=__version__,
    )
    app.state.container = container

    register_error_handlers(app)
    app.include_router(api_router, prefix="/api")

    _mount_frontend(app, settings.web_dir)
    logger.info("应用已就绪, 数据库: %s", settings.database_path)
    return app


def _asset_version(web_dir: Path) -> str:
    """用前端文件的最新修改时间作为版本号, 供页面里的静态资源缓存失效使用。"""

    latest = 0.0
    try:
        for path in web_dir.rglob("*"):
            if path.is_file():
                latest = max(latest, path.stat().st_mtime)
    except OSError:  # pragma: no cover - 极端情况下退化为固定版本号
        logger.warning("无法读取前端文件时间戳: %s", web_dir)
    return str(int(latest))


def _frontend_page(page_file: Path, web_dir: Path) -> Response:
    """读取页面并把静态资源版本号替换为当前文件时间戳。

    版本号保证浏览器不会把新页面和旧脚本/样式混用; 否则删除或新增
    页面元素后, 旧脚本会因为找不到元素而静默报错 (页面看起来 "没反应")。
    """

    try:
        html = page_file.read_text(encoding="utf-8")
    except OSError as exc:
        logger.error("读取前端页面失败 %s: %s", page_file, exc)
        return JSONResponse(
            status_code=500,
            content={"error": {"code": "frontend_missing", "message": "前端资源缺失"}},
        )
    return HTMLResponse(html.replace("__ASSET_VERSION__", _asset_version(web_dir)))


def _mount_frontend(app: FastAPI, web_dir: Path) -> None:
    """挂载总览、条件选股及各工具页面。"""

    if not web_dir.is_dir():
        logger.warning("前端目录不存在: %s", web_dir)

        @app.get(tuple(FRONTEND_PAGES), include_in_schema=False)
        def missing_frontend() -> JSONResponse:  # pragma: no cover
            return JSONResponse(
                status_code=500,
                content={"error": {"code": "frontend_missing", "message": "前端资源缺失"}},
            )

        return

    app.mount("/static", StaticFiles(directory=str(web_dir)), name="static")

    @app.get("/", include_in_schema=False)
    def overview_page() -> Response:
        return _frontend_page(web_dir / "overview.html", web_dir)

    @app.get("/screen", include_in_schema=False)
    @app.get("/screen/stocks", include_in_schema=False)
    def screen_page() -> Response:
        """条件选股的股票筛选子页面。"""

        return _frontend_page(web_dir / "index.html", web_dir)

    @app.get("/screen/strategies", include_in_schema=False)
    def strategy_design_page() -> Response:
        """条件选股的策略设计子页面。"""

        return _frontend_page(web_dir / "strategy.html", web_dir)

    @app.get("/watchlist", include_in_schema=False)
    def watchlist_page() -> Response:
        """页面 2: 自选股。"""

        return _frontend_page(web_dir / "watchlist.html", web_dir)

    @app.get("/strategy", include_in_schema=False)
    def strategy_page() -> Response:
        """保留旧书签入口。"""

        return RedirectResponse("/screen/strategies", status_code=307)

    @app.get("/data", include_in_schema=False)
    def data_page() -> Response:
        """页面 4: 本地数据管理。"""

        return _frontend_page(web_dir / "data.html", web_dir)

    @app.get("/stock-ladder", include_in_schema=False)
    def ladder_page() -> Response:
        return _frontend_page(web_dir / "ladder.html", web_dir)

    @app.get("/multi-chart", include_in_schema=False)
    def multi_chart_page() -> Response:
        return _frontend_page(web_dir / "multi-chart.html", web_dir)

    @app.get("/review", include_in_schema=False)
    def review_page() -> Response:
        return _frontend_page(web_dir / "review.html", web_dir)

    @app.middleware("http")
    async def _revalidate_frontend(request: Request, call_next):
        """页面与静态资源每次都必须回源校验, 避免浏览器复用过期文件。"""

        response = await call_next(request)
        path = request.url.path
        if path in FRONTEND_PAGES or path.startswith("/static/"):
            response.headers["Cache-Control"] = "no-cache, must-revalidate"
        return response
"""uvicorn 启动方式: ``uvicorn --factory app.main:create_app``。"""
