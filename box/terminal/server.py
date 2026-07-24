"""The Box's web console — a small Starlette app that replaces ttyd.

Serves an xterm.js page (session tabs, a toggleable rail, a Files view) bridged to
tmux over a WebSocket. A "session" IS a tmux session: tmux is the source of truth,
so there's no JSON session state to keep in sync. No auth — single-user and
loopback-only, the Launcher forwards this port to the Mac's loopback ONLY (ADR
0001). No `docker exec` — this runs INSIDE the Box, so it attaches tmux directly.
"""
from __future__ import annotations

import asyncio
import fcntl
import json
import os
import struct
import subprocess
import termios

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import (
    PlainTextResponse,
    RedirectResponse,
    Response,
)
from starlette.routing import Mount, Route, WebSocketRoute
from starlette.staticfiles import StaticFiles
from starlette.templating import Jinja2Templates
from starlette.websockets import WebSocket, WebSocketDisconnect

from paths import safe_path, sanitize_session_name

_HERE = os.path.dirname(os.path.abspath(__file__))
WORKSPACE = os.environ.get("CLAUDEBOX_WORKSPACE", "/workspace")
DEFAULT_SESSION = "main"
templates = Jinja2Templates(directory=os.path.join(_HERE, "templates"))


def list_sessions() -> list[str]:
    """Live tmux session names, or [] if the tmux server isn't up yet."""
    r = subprocess.run(
        ["tmux", "list-sessions", "-F", "#{session_name}"],
        capture_output=True,
        text=True,
    )
    if r.returncode != 0:
        return []
    return [ln for ln in r.stdout.splitlines() if ln]


def ensure_session(name: str) -> None:
    # idempotent-ish; harmless if it already exists
    subprocess.run(["tmux", "new-session", "-d", "-s", name], capture_output=True)


def kill_session(name: str) -> None:
    subprocess.run(["tmux", "kill-session", "-t", name], capture_output=True)


def _auto_name() -> str:
    existing = set(list_sessions())
    n = 1
    while f"session-{n}" in existing:
        n += 1
    return f"session-{n}"


def _shell_ctx(sid: str, tab: str, **extra) -> dict:
    return {
        "sessions": [{"id": n, "title": n} for n in list_sessions()],
        "s": {"id": sid, "title": sid},
        "tab": tab,
        **extra,
    }


async def index(request: Request) -> Response:
    sessions = list_sessions()
    if not sessions:
        ensure_session(DEFAULT_SESSION)
        sessions = [DEFAULT_SESSION]
    return RedirectResponse(f"/sessions/{sessions[0]}", 303)


async def session_detail(request: Request) -> Response:
    sid = sanitize_session_name(request.path_params["sid"])
    ensure_session(sid)
    return templates.TemplateResponse(request, "session.html", _shell_ctx(sid, "terminal"))


async def session_create(request: Request) -> Response:
    name = sanitize_session_name(request.query_params.get("name") or _auto_name())
    ensure_session(name)
    return RedirectResponse(f"/sessions/{name}", 303)


async def session_close(request: Request) -> Response:
    sid = sanitize_session_name(request.path_params["sid"])
    kill_session(sid)
    rem = list_sessions()
    return RedirectResponse(f"/sessions/{rem[0]}" if rem else "/", 303)


async def session_files(request: Request) -> Response:
    sid = sanitize_session_name(request.path_params["sid"])
    rel = request.query_params.get("path", "").lstrip("/")
    target = safe_path(WORKSPACE, rel)
    if target is None or not os.path.exists(target):
        return PlainTextResponse("Not found (or outside the Workspace).", 404)
    ctx = _shell_ctx(sid, "files", rel=rel)
    if os.path.isdir(target):
        entries = []
        for nm in sorted(os.listdir(target)):
            if nm == ".git":
                continue
            full = os.path.join(target, nm)
            entries.append(
                {
                    "name": nm,
                    "is_dir": os.path.isdir(full),
                    "rel": os.path.join(rel, nm) if rel else nm,
                }
            )
        ctx.update(
            is_dir=True,
            entries=entries,
            parent=(os.path.dirname(rel) if rel else None),
        )
    else:
        try:
            with open(target, "r", encoding="utf-8") as f:
                body = f.read()
        except (UnicodeDecodeError, ValueError):
            body = None
        ctx.update(is_dir=False, body=body)
    return templates.TemplateResponse(request, "files.html", ctx)


async def favicon(request: Request) -> Response:
    return Response(status_code=204)


def _set_winsize(fd: int, rows: int, cols: int) -> None:
    winsize = struct.pack("HHHH", rows, cols, 0, 0)
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)
    except OSError:
        pass


def _become_ctty() -> None:
    # Runs in the child after fork, before exec. Make the pty slave the
    # controlling terminal so the kernel delivers SIGWINCH to the tmux client
    # on TIOCSWINSZ — without this, plain setsid() leaves no controlling tty
    # and the client is stuck at its 80x24 startup fallback (never resizes).
    os.setsid()
    fcntl.ioctl(0, termios.TIOCSCTTY, 0)


async def terminal_ws(ws: WebSocket) -> None:
    sid = sanitize_session_name(ws.path_params["sid"])
    await ws.accept()

    master, slave = os.openpty()
    env = {**os.environ, "TERM": "xterm-256color"}
    proc = subprocess.Popen(
        ["tmux", "new-session", "-A", "-s", sid],
        stdin=slave,
        stdout=slave,
        stderr=slave,
        preexec_fn=_become_ctty,
        close_fds=True,
        env=env,
    )
    os.close(slave)
    os.set_blocking(master, False)

    loop = asyncio.get_running_loop()
    closing = False

    def on_master_readable() -> None:
        nonlocal closing
        try:
            data = os.read(master, 65536)
        except BlockingIOError:
            return
        except OSError:
            data = b""
        if not data:  # PTY closed -> the attach process exited
            loop.remove_reader(master)
            if not closing:
                asyncio.create_task(_bye("terminal exited"))
            return
        asyncio.create_task(ws.send_bytes(data))

    async def _bye(reason: str) -> None:
        nonlocal closing
        if closing:
            return
        closing = True
        try:
            await ws.close(code=1000, reason=reason)
        except RuntimeError:
            pass

    loop.add_reader(master, on_master_readable)

    try:
        while True:
            msg = await ws.receive()
            if msg["type"] == "websocket.disconnect":
                break
            data = msg.get("bytes")
            if data is not None:
                os.write(master, data)
                continue
            text = msg.get("text")
            if text:
                try:
                    ctl = json.loads(text)
                except ValueError:
                    os.write(master, text.encode())
                    continue
                r = ctl.get("resize")
                if r:
                    _set_winsize(master, int(r.get("rows", 24)), int(r.get("cols", 80)))
    except WebSocketDisconnect:
        pass
    finally:
        closing = True
        try:
            loop.remove_reader(master)
        except (ValueError, OSError):
            pass
        try:
            os.close(master)
        except OSError:
            pass
        # Detaching from tmux (or killing the attach proc) leaves the tmux session alive.
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                proc.kill()


def create_app() -> Starlette:
    routes = [
        Route("/", index),
        Route("/sessions", session_create, methods=["POST"]),
        Route("/sessions/{sid}", session_detail),
        Route("/sessions/{sid}/close", session_close, methods=["POST"]),
        Route("/sessions/{sid}/files", session_files),
        Route("/favicon.ico", favicon),
        WebSocketRoute("/sessions/{sid}/terminal", terminal_ws),
        Mount("/static", StaticFiles(directory=os.path.join(_HERE, "static")), name="static"),
    ]
    return Starlette(routes=routes)


app = create_app()
