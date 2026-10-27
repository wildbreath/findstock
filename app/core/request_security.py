"""本机默认访问边界，以及跨站请求和可选的远程访问凭证校验。"""

from __future__ import annotations

import base64
import binascii
import ipaddress
import secrets

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from starlette.middleware.trustedhost import TrustedHostMiddleware

from app.core.config import Settings


def _authorized(request: Request, token: str) -> bool:
    authorization = request.headers.get("authorization", "")
    scheme, _, credential = authorization.partition(" ")
    if scheme.lower() == "basic":
        try:
            decoded = base64.b64decode(credential, validate=True).decode("utf-8")
            credential = decoded.partition(":")[2]
        except (ValueError, binascii.Error):
            return False
    elif scheme.lower() != "bearer":
        return False
    return secrets.compare_digest(credential.encode(), token.encode())


def register_request_security(app: FastAPI, settings: Settings) -> None:
    @app.middleware("http")
    async def protect_request(request: Request, call_next):
        origin = request.headers.get("origin")
        if request.headers.get("sec-fetch-site") == "cross-site" or (
            origin is not None and origin != f"{request.url.scheme}://{request.url.netloc}"
        ):
            return JSONResponse(status_code=403, content={"error": {
                "code": "untrusted_origin", "message": "不接受跨站请求",
            }})
        try:
            local = (
                request.client is not None
                and ipaddress.ip_address(request.client.host).is_loopback
            )
        except ValueError:
            local = False
        if not local:
            if not settings.access_token:
                return JSONResponse(status_code=403, content={"error": {
                    "code": "remote_access_disabled", "message": "远程访问需要配置访问凭证",
                }})
            if not _authorized(request, settings.access_token):
                return JSONResponse(
                    status_code=401,
                    headers={"WWW-Authenticate": 'Basic realm="FindStock", charset="UTF-8"'},
                    content={"error": {"code": "unauthorized", "message": "请输入访问凭证"}},
                )
        return await call_next(request)

    if any("*" in host for host in settings.allowed_hosts):
        raise ValueError("允许访问的主机必须逐个列出，不能使用通配符。")
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=list(settings.allowed_hosts))
