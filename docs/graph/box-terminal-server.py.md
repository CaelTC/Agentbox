---
tags: [box]
---

# `box/terminal/server.py`

The web console — Starlette on `127.0.0.1:7681`, loopback only. Serves the terminal page and the WebSocket that runs [[box-bin-agentbox-session|box/bin/agentbox-session]] on a pty, plus a read-only file listing.
