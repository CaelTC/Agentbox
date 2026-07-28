#!/usr/bin/env bash
#
# start-terminal.sh — serve the Box's web console: a small Starlette app (uvicorn)
# running IN the Box that bridges the browser (xterm.js) to tmux sessions over a
# WebSocket. Session tabs, a toggleable rail, and a Files view. The Launcher
# forwards this port to the Mac's loopback ONLY, so the LAN can never reach it
# (ADR 0001). Replaces ttyd.
set -euo pipefail

PORT="${AGENTBOX_TERMINAL_PORT:-7681}"

# Binds 0.0.0.0 INSIDE the Box; only the loopback forward is exposed to the Mac.
# ponytail: no restart supervisor — if it dies the console is gone until the Box
# restarts; add an `until … ; do sleep 1; done` loop if that bites.
exec /opt/terminal-venv/bin/python -m uvicorn server:app \
  --app-dir /opt/terminal --host 0.0.0.0 --port "$PORT" --log-level warning
