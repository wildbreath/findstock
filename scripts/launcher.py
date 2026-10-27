"""一键启动器。

行为:

1. 补全 ``sys.path``, 使脚本可以直接双击运行;
2. 检查运行依赖, 缺失时自动 ``pip install -r requirements.txt``;
3. 若服务已在运行, 直接打开浏览器, 不会重复启动;
4. 选择一个空闲端口, 启动 Web 服务, 就绪后自动打开浏览器;
5. 在控制台打印数据状态与停止方式。

按 ``Ctrl+C`` 或直接关闭窗口即可停止服务。
"""

from __future__ import annotations

import argparse
import importlib.util
from importlib.metadata import PackageNotFoundError, version
import json
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8000
PORT_SCAN_LIMIT = 20

#: 运行所需的三方包 (按导入名检查)。
REQUIRED_MODULES = ("fastapi", "uvicorn", "pydantic", "akshare")

HEALTH_PATH = "/api/health"
BROWSER_WAIT_SECONDS = 90.0


def ensure_project_environment(argv: list[str]) -> int | None:
    """只在项目虚拟环境中安装和启动，避免改动宿主的共享 Python。"""

    environment = PROJECT_ROOT / ".venv"
    if Path(sys.prefix).resolve() == environment.resolve():
        return None
    python = environment / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
    if not python.is_file():
        print("[环境] 正在创建项目独立环境（仅首次运行）…")
        result = subprocess.run([sys.executable, "-m", "venv", str(environment)], cwd=PROJECT_ROOT)
        if result.returncode:
            print("[环境] 创建失败，请检查 Python 是否包含 venv 和 pip。")
            return result.returncode
    return subprocess.run([str(python), str(Path(__file__).resolve()), *argv], cwd=PROJECT_ROOT).returncode


def ensure_project_on_path() -> None:
    """让脚本可以被直接双击执行 (此时 sys.path[0] 是 scripts 目录)。"""

    root = str(PROJECT_ROOT)
    if root not in sys.path:
        sys.path.insert(0, root)


def configure_stdout() -> None:
    """让提示信息立即出现 (输出被重定向到管道/文件时默认会缓冲)。"""

    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is None:  # pragma: no cover - 被替换过的流
            continue
        try:
            reconfigure(encoding="utf-8", line_buffering=True)
        except (ValueError, OSError):  # pragma: no cover - 某些终端不支持
            continue


def set_console_title(title: str) -> None:
    """设置控制台标题 (由 Python 设置, 因此 .bat 可以保持纯 ASCII)。"""

    if sys.platform != "win32":  # pragma: no cover - 平台相关
        return
    try:
        import ctypes

        ctypes.windll.kernel32.SetConsoleTitleW(title)
    except Exception:  # noqa: BLE001 - 标题失败不影响启动
        pass


def missing_modules() -> list[str]:
    """返回当前环境中缺失的依赖模块名。"""

    return [name for name in REQUIRED_MODULES if importlib.util.find_spec(name) is None]


def ensure_dependencies() -> bool:
    """确保依赖齐全; 缺失时尝试自动安装。返回是否可用。"""

    requirements = PROJECT_ROOT / "requirements.txt"
    if not requirements.is_file():
        print(f"[依赖] 找不到 {requirements}, 无法自动安装。")
        return False

    problems = missing_modules()
    for line in requirements.read_text(encoding="utf-8-sig").splitlines():
        package, separator, wanted = line.partition("==")
        if not separator or line.lstrip().startswith("#"):
            continue
        package = package.strip().split("[")[0]
        try:
            installed = version(package)
        except PackageNotFoundError:
            installed = None
        if installed != wanted.strip():
            problems.append(f"{package} 需要 {wanted.strip()}（当前 {installed or '未安装'}）")
    if not problems:
        check = subprocess.run(
            [sys.executable, "-c", "; ".join(f"import {name}" for name in REQUIRED_MODULES)],
            capture_output=True, text=True,
        )
        if check.returncode == 0:
            return True
        print("[依赖] 依赖无法正常导入，请在项目环境中重新安装依赖。")
        print(check.stderr)
        return False

    if Path(sys.prefix).resolve() != (PROJECT_ROOT / ".venv").resolve():
        print("[依赖] 自动安装仅允许在项目 .venv 中运行，请通过启动器启动。")
        return False
    print(f"[依赖] 需要补齐: {', '.join(problems)}")
    print("[依赖] 正在自动安装, 首次运行需要几分钟…")
    result = subprocess.run(  # noqa: S603 - 参数全部由本模块构造
        [sys.executable, "-m", "pip", "install", "-r", str(requirements)],
        cwd=str(PROJECT_ROOT),
    )
    if result.returncode != 0:
        print("[依赖] 安装失败, 请手动执行:")
        print(f'       "{sys.executable}" -m pip install -r "{requirements}"')
        return False

    # 校验在独立进程中进行，避免 Windows 锁住待更新的扩展模块。
    importlib.invalidate_caches()
    check = subprocess.run(
        [sys.executable, "-c", "; ".join(f"import {name}" for name in REQUIRED_MODULES)],
        capture_output=True, text=True,
    )
    if check.returncode:
        print(f"[依赖] 安装后仍无法导入: {check.stderr}")
        return False
    print("[依赖] 安装完成。")
    return True


def port_is_open(host: str, port: int, timeout: float = 0.6) -> bool:
    """端口上是否有进程在监听。"""

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(timeout)
        return sock.connect_ex((host, port)) == 0


def health_of(host: str, port: int, timeout: float = 1.5) -> dict | None:
    """读取 ``/api/health``; 不是本系统的服务时返回 None。"""

    url = f"http://{host}:{port}{HEALTH_PATH}"
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:  # noqa: S310
            payload = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, ValueError, TimeoutError):
        return None
    if isinstance(payload, dict) and payload.get("status") == "ok" and "version" in payload:
        return payload
    return None


def find_free_port(host: str, start: int, *, limit: int = PORT_SCAN_LIMIT) -> int:
    """从 ``start`` 开始找一个空闲端口。"""

    for offset in range(limit):
        candidate = start + offset
        if not port_is_open(host, candidate):
            return candidate
    raise RuntimeError(
        f"{host} 上 {start}~{start + limit - 1} 端口都被占用, "
        "请用 --port 指定其他端口。"
    )


def open_browser_when_ready(host: str, port: int, url: str) -> None:
    """后台等待服务就绪, 然后打开浏览器。"""

    deadline = time.monotonic() + BROWSER_WAIT_SECONDS
    while time.monotonic() < deadline:
        if health_of(host, port) is not None:
            webbrowser.open(url)
            print(f"[启动] 已打开浏览器: {url}")
            return
        time.sleep(0.4)
    print(f"[启动] 等待服务就绪超时, 请手动访问: {url}")


def describe_data(container) -> None:
    """打印本地数据概况, 便于用户判断是否需要初始化。"""

    try:
        coverage = container.data_sync_service.coverage()
    except Exception as exc:  # noqa: BLE001 - 仅用于提示, 不应影响启动
        print(f"[数据] 无法读取本地数据状态: {exc}")
        return

    if coverage.bar_count == 0:
        print("[数据] 本地还没有行情数据。")
        print("[数据] 请在页面上点击「初始化 (下载最近两年)」开始首次下载。")
        return

    print(
        f"[数据] 行情 {coverage.bar_start} ~ {coverage.bar_end}, "
        f"{coverage.bar_count} 条日线, 覆盖 {coverage.stock_count} 只沪深A股, "
        f"已完成 {coverage.complete_days} 个交易日"
    )
    if coverage.complete_days == 0:
        print("[数据] 还没有完整下载的交易日, 建议先执行数据更新。")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    """解析命令行参数。"""

    parser = argparse.ArgumentParser(description="一键启动沪深A股自动筛选系统")
    parser.add_argument("--host", default=DEFAULT_HOST, help="监听地址")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="起始端口")
    parser.add_argument(
        "--no-browser", action="store_true", help="启动后不自动打开浏览器"
    )
    parser.add_argument(
        "--reload", action="store_true", help="开发模式: 代码变更后自动重启"
    )
    parser.add_argument(
        "--skip-deps", action="store_true", help="跳过依赖检查 (自行保证环境完整)"
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    """启动入口。"""

    args = parse_args(argv)
    ensure_project_on_path()
    configure_stdout()
    child_result = ensure_project_environment(sys.argv[1:] if argv is None else argv)
    if child_result is not None:
        return child_result
    set_console_title("沪深A股自动筛选系统")

    print("=" * 62)
    print("  沪深A股自动筛选系统")
    print("=" * 62)

    if not args.skip_deps and not ensure_dependencies():
        print("[退出] 依赖不完整, 启动已中止。")
        return 1

    connect_host = "127.0.0.1" if args.host == "0.0.0.0" else args.host
    # 已经启动过就直接复用, 避免重复占用端口。
    if health_of(connect_host, args.port) is not None:
        url = f"http://{connect_host}:{args.port}"
        print(f"[启动] 服务已在运行: {url}")
        if not args.no_browser:
            webbrowser.open(url)
        return 0

    try:
        port = find_free_port(connect_host, args.port)
    except RuntimeError as exc:
        print(f"[退出] {exc}")
        return 1
    if port != args.port:
        print(f"[启动] 端口 {args.port} 已被占用, 改用 {port}")

    url = f"http://{connect_host}:{port}"
    print(f"[启动] 正在启动服务: {url}")

    from app.container import Container
    from app.core.config import get_settings
    from app.core.logging import configure_logging

    settings = get_settings()
    configure_logging(settings)
    try:
        describe_data(Container.build(settings))
    except Exception as exc:  # noqa: BLE001 - 数据状态仅用于提示
        print(f"[数据] 状态读取失败: {exc}")

    if not args.no_browser:
        threading.Thread(
            target=open_browser_when_ready,
            args=(connect_host, port, url),
            daemon=True,
        ).start()

    import uvicorn

    print("-" * 62)
    print(f"  浏览器访问: {url}")
    print(f"  接口文档:   {url}/docs")
    print("  停止服务:   在本窗口按 Ctrl+C, 或直接关闭窗口")
    print("-" * 62)

    try:
        uvicorn.run(
            "app.main:create_app",
            factory=True,
            host=args.host,
            port=port,
            reload=args.reload,
            log_level="info",
        )
    except KeyboardInterrupt:  # pragma: no cover - 交互路径
        print("\n[退出] 服务已停止。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
