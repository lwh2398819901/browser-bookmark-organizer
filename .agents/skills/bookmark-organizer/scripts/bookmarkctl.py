#!/usr/bin/env python3
"""通过短时本地桥接页面调用收藏夹整理扩展。"""

from __future__ import annotations

import argparse
import html
import json
import os
import platform
import shutil
import subprocess
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


DEFAULT_CONFIG = Path.home() / ".bookmark-organizer" / "bridge.json"
MAX_RESPONSE_BYTES = 10 * 1024 * 1024


def configure_stdio() -> None:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8")


def load_config(path: Path) -> dict[str, Any]:
    try:
        config = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise RuntimeError(
            f"本地桥接尚未安装：{path}。请先运行仓库 installer/install.py 并重新加载扩展。"
        ) from error
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"无法读取本地桥接配置：{path}：{error}") from error
    for key in ("extensionId", "token"):
        if not isinstance(config.get(key), str) or not config[key]:
            raise RuntimeError(f"本地桥接配置缺少 {key}：{path}")
    return config


def browser_candidates(browser: str) -> list[Path]:
    system = platform.system()
    if system == "Windows":
        variables = {
            "program_files": Path(os.environ.get("ProgramFiles", "C:/Program Files")),
            "program_files_x86": Path(os.environ.get("ProgramFiles(x86)", "C:/Program Files (x86)")),
            "local_app_data": Path(os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData/Local"))),
        }
        mapping = {
            "edge": [
                variables["program_files_x86"] / "Microsoft/Edge/Application/msedge.exe",
                variables["program_files"] / "Microsoft/Edge/Application/msedge.exe",
            ],
            "chrome": [
                variables["program_files"] / "Google/Chrome/Application/chrome.exe",
                variables["program_files_x86"] / "Google/Chrome/Application/chrome.exe",
                variables["local_app_data"] / "Google/Chrome/Application/chrome.exe",
            ],
            "brave": [
                variables["program_files"] / "BraveSoftware/Brave-Browser/Application/brave.exe",
                variables["program_files_x86"] / "BraveSoftware/Brave-Browser/Application/brave.exe",
                variables["local_app_data"] / "BraveSoftware/Brave-Browser/Application/brave.exe",
            ],
        }
        return mapping[browser]
    if system == "Darwin":
        mapping = {
            "edge": [Path("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge")],
            "chrome": [Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")],
            "brave": [Path("/Applications/Brave Browser.app/Contents/MacOS/Brave Browser")],
        }
        return mapping[browser]
    mapping = {
        "edge": [Path("/usr/bin/microsoft-edge"), Path("/usr/bin/microsoft-edge-stable")],
        "chrome": [Path("/usr/bin/google-chrome"), Path("/usr/bin/google-chrome-stable"), Path("/usr/bin/chromium")],
        "brave": [Path("/usr/bin/brave-browser"), Path("/usr/bin/brave")],
    }
    return mapping[browser]


def find_browser(browser: str, configured: str | None = None) -> Path:
    if configured:
        candidate = Path(configured).expanduser()
        if candidate.is_file():
            return candidate
    command_names = {
        "edge": ["msedge", "microsoft-edge", "microsoft-edge-stable"],
        "chrome": ["chrome", "google-chrome", "google-chrome-stable", "chromium"],
        "brave": ["brave", "brave-browser"],
    }
    for name in command_names[browser]:
        found = shutil.which(name)
        if found:
            return Path(found)
    for candidate in browser_candidates(browser):
        if candidate.is_file():
            return candidate
    raise RuntimeError(f"没有找到 {browser} 浏览器。可在 {DEFAULT_CONFIG} 中设置 browserExecutable。")


def javascript_literal(value: Any) -> str:
    """渲染成可安全内联进 <script> 的 JSON 字面量。

    ``json.dumps`` 不会转义 ``</script>``，直接内联会让书签名或目录名提前闭合脚本标签；
    该页面同时持有本地令牌，因此必须转义 HTML 敏感字符与 JS 行分隔符。
    """
    return (
        json.dumps(value, ensure_ascii=False)
        .replace("&", "\\u0026")
        .replace("<", "\\u003c")
        .replace(">", "\\u003e")
        .replace("\u2028", "\\u2028")
        .replace("\u2029", "\\u2029")
    )


def bridge_html(extension_id: str, token: str, request: dict[str, Any], nonce: str) -> bytes:
    extension_literal = javascript_literal(extension_id)
    message_literal = javascript_literal({"token": token, "request": request})
    nonce_literal = javascript_literal(nonce)
    document = f"""<!doctype html>
<meta charset="utf-8">
<title>收藏夹本地桥接</title>
<style>
body{{font:16px system-ui;margin:40px;color:#17342f;background:#f7faf9}}
main{{max-width:560px;margin:auto;padding:28px;border:1px solid #cad7d3;border-radius:18px;background:white}}
</style>
<main><h1>正在连接收藏夹…</h1><p id="state">无需操作，完成后窗口会自动关闭。</p></main>
<script>
const extensionId = {extension_literal};
const message = {message_literal};
const nonce = {nonce_literal};
const state = document.querySelector('#state');
function finish(payload) {{
  fetch('/result/' + nonce, {{method:'POST', headers:{{'Content-Type':'application/json'}}, body:JSON.stringify(payload)}})
    .finally(() => setTimeout(() => window.close(), 150));
}}
if (!globalThis.chrome?.runtime?.sendMessage) {{
  finish({{ok:false,error:'当前浏览器没有提供扩展外部消息接口。请确认使用已安装扩展的 Chromium 浏览器。'}});
}} else {{
  chrome.runtime.sendMessage(extensionId, message, response => {{
    if (chrome.runtime.lastError) finish({{ok:false,error:chrome.runtime.lastError.message}});
    else finish(response || {{ok:false,error:'扩展没有返回结果。'}});
  }});
}}
</script>"""
    return document.encode("utf-8")


def bridge_handler(page: bytes, nonce: str, state: dict[str, Any], completed: threading.Event):
    """构造桥接页与结果接收端点。独立成函数是为了让失效路径可被回归测试覆盖。"""

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            if urlparse(self.path).path != f"/bridge/{nonce}":
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(page)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(page)

        def do_POST(self) -> None:  # noqa: N802
            if urlparse(self.path).path != f"/result/{nonce}":
                self.send_error(404)
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length < 1 or length > MAX_RESPONSE_BYTES:
                    raise ValueError("响应大小无效")
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
                state["response"] = payload
                completed.set()
                body = b"ok"
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except (ValueError, UnicodeDecodeError, json.JSONDecodeError) as error:
                # 必须立刻唤醒等待者，否则命令会空等满超时并报告成“连接超时”。
                state["response"] = {"ok": False, "error": f"扩展响应无法解析：{error}"}
                completed.set()
                # 状态行只能放 latin-1 字符，中文说明必须走 explain（响应正文），否则会抛
                # UnicodeEncodeError 并直接断开连接，客户端拿不到任何响应。
                self.send_error(400, "Bad Request", html.escape(str(error)))

        def log_message(self, _format: str, *_args: Any) -> None:
            return

    return Handler


def invoke_bridge(config: dict[str, Any], request: dict[str, Any], browser: str, timeout: float) -> Any:
    nonce = uuid.uuid4().hex
    state: dict[str, Any] = {"response": None}
    completed = threading.Event()
    page = bridge_html(config["extensionId"], config["token"], request, nonce)

    server = ThreadingHTTPServer(("127.0.0.1", 0), bridge_handler(page, nonce, state, completed))
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    try:
        executable = find_browser(browser, config.get("browserExecutable"))
        url = f"http://127.0.0.1:{server.server_port}/bridge/{nonce}"
        # 说明：Chromium/Edge 没有可用的 --start-minimized 开关，桥接窗口只能保持小尺寸，
        # 完成后由页面自行关闭，不要向用户承诺“默认最小化”。
        subprocess.Popen(  # noqa: S603
            [
                str(executable),
                f"--app={url}",
                "--window-size=420,240",
                "--no-first-run",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        if not completed.wait(timeout):
            raise RuntimeError(
                f"等待扩展响应超时（{timeout:g} 秒）。请确认扩展已启用并重新加载，扩展 ID 为 {config['extensionId']}。"
            )
        response = state["response"]
        if not isinstance(response, dict):
            raise RuntimeError("扩展返回了无法识别的响应。")
        if not response.get("ok"):
            raise RuntimeError(str(response.get("error") or "扩展执行失败。"))
        return response.get("result")
    finally:
        server.shutdown()
        server.server_close()
        server_thread.join(timeout=2)


def read_plan(path: str) -> list[dict[str, str]]:
    raw = sys.stdin.read() if path == "-" else Path(path).read_text(encoding="utf-8-sig")
    # 通过管道传入时也兼容 PowerShell 5.1 可能保留的 UTF-8 BOM。
    raw = raw.lstrip("\ufeff")
    try:
        plan = json.loads(raw)
    except json.JSONDecodeError as error:
        raise RuntimeError(f"整理方案不是有效 JSON：{error}") from error
    if not isinstance(plan, list):
        raise RuntimeError("整理方案必须是 JSON 数组。")
    return plan


def build_request(args: argparse.Namespace) -> dict[str, Any]:
    if args.command in {"status", "scan", "backup"}:
        return {"command": args.command}
    if args.command == "archives":
        return {"command": "archives.list"}
    if args.command == "operations":
        return {"command": "operations.list"}
    if args.command == "validate-plan":
        return {"command": "plan.validate", "plan": read_plan(args.file)}
    if args.command == "apply-plan":
        if not args.confirmed:
            raise RuntimeError("执行移动前必须在用户确认预览后显式传入 --confirmed。")
        return {"command": "plan.apply", "planToken": args.plan_token, "confirmed": True}
    if args.command == "undo":
        if not args.confirmed:
            raise RuntimeError("撤销会移动书签，必须在用户确认后显式传入 --confirmed。")
        return {"command": "operations.undo", "operationId": args.operation_id, "confirmed": True}
    raise RuntimeError(f"未知命令：{args.command}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="通过本地浏览器扩展管理收藏夹")
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--browser", choices=("edge", "chrome", "brave"))
    parser.add_argument("--timeout", type=float, default=30.0)
    parser.add_argument("--pretty", action="store_true", help="以缩进 JSON 输出")
    parser.add_argument("--output", type=Path, help="将结果直接写入无 BOM UTF-8 JSON 文件，不依赖控制台编码")
    subparsers = parser.add_subparsers(dest="command", required=True)
    for name in ("status", "scan", "backup", "archives", "operations"):
        subparsers.add_parser(name)
    validate = subparsers.add_parser("validate-plan")
    validate.add_argument("--file", default="-", help="方案 JSON 文件；- 表示标准输入")
    apply_plan = subparsers.add_parser("apply-plan")
    apply_plan.add_argument("--plan-token", required=True)
    apply_plan.add_argument("--confirmed", action="store_true")
    undo = subparsers.add_parser("undo")
    undo.add_argument("--operation-id")
    undo.add_argument("--confirmed", action="store_true")
    return parser.parse_args()


def write_json_result(result: Any, path: Path, pretty: bool) -> None:
    serialized = json.dumps(result, ensure_ascii=False, indent=2 if pretty else None) + "\n"
    path.write_text(serialized, encoding="utf-8")


def main() -> int:
    configure_stdio()
    args = parse_args()
    try:
        config = load_config(args.config.expanduser())
        browser = args.browser or config.get("browser") or "edge"
        result = invoke_bridge(config, build_request(args), browser, args.timeout)
        if args.output:
            write_json_result(result, args.output, args.pretty)
        else:
            print(json.dumps(result, ensure_ascii=False, indent=2 if args.pretty else None))
        return 0
    except (OSError, RuntimeError) as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
