"""The Box's web console — a small Starlette app that replaces ttyd.

A single-Project console: one Project's Claude session (an xterm.js page bridged
to tmux over a WebSocket) plus a read-only Files view of the Workspace. Every
session is a Project reached through the `claudebox-session` funnel, so the
console never creates or switches free-form sessions — that lives in the
Launcher. No auth — single-user and loopback-only, the Launcher forwards this
port to the Mac's loopback ONLY (ADR 0001). This runs INSIDE the Box, so it
launches sessions via the funnel directly (no `docker exec`).
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
from starlette.responses import PlainTextResponse, Response
from starlette.routing import Mount, Route, WebSocketRoute
from starlette.staticfiles import StaticFiles
from starlette.templating import Jinja2Templates
from starlette.websockets import WebSocket, WebSocketDisconnect

from paths import is_valid_slug, safe_path

_HERE = os.path.dirname(os.path.abspath(__file__))
WORKSPACE = os.environ.get("CLAUDEBOX_WORKSPACE", "/workspace")
templates = Jinja2Templates(directory=os.path.join(_HERE, "templates"))


def project_exists(slug: str) -> bool:
    """A slug names a real Project only if its metadata file is on the volume."""
    return is_valid_slug(slug) and os.path.isfile(
        os.path.join(WORKSPACE, slug, ".claudebox", "project.json")
    )


def _ctx(sid: str, tab: str, **extra) -> dict:
    return {"s": {"id": sid, "title": sid}, "tab": tab, **extra}


async def index(request: Request) -> Response:
    # No auto-select, no auto-create: Projects are opened from the Launcher.
    return PlainTextResponse("Open a Project from Claudebox to start a Claude session.")


async def session_detail(request: Request) -> Response:
    sid = request.path_params["sid"]
    if not project_exists(sid):
        return PlainTextResponse("No such Project.", 404)
    return templates.TemplateResponse(request, "session.html", _ctx(sid, "terminal"))


async def session_files(request: Request) -> Response:
    sid = request.path_params["sid"]
    if not project_exists(sid):
        return PlainTextResponse("No such Project.", 404)
    rel = request.query_params.get("path", "").lstrip("/")
    target = safe_path(WORKSPACE, rel)
    if target is None or not os.path.exists(target):
        return PlainTextResponse("Not found (or outside the Workspace).", 404)
    ctx = _ctx(sid, "files", rel=rel)
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
    sid = ws.path_params["sid"]
    if not project_exists(sid):
        await ws.close(code=1008, reason="no such Project")
        return
    await ws.accept()

    master, slave = os.openpty()
    env = {**os.environ, "TERM": "xterm-256color"}
    # Launch the Project through the ONE funnel — never a bare tmux/shell. Stdout
    # is a tty here, so claudebox-session attaches (creating + seeding on first open).
    proc = subprocess.Popen(
        ["claudebox-session", sid],
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
        Route("/sessions/{sid}", session_detail),
        Route("/sessions/{sid}/files", session_files),
        Route("/favicon.ico", favicon),
        WebSocketRoute("/sessions/{sid}/terminal", terminal_ws),
        Mount("/static", StaticFiles(directory=os.path.join(_HERE, "static")), name="static"),
    ]
    return Starlette(routes=routes)


app = create_app()
