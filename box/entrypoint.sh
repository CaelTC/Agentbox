#!/usr/bin/env bash
# The Box's entrypoint. Applies the egress firewall (ticket 02) exactly once at
# container start, then hands off to the container command. Runs as the
# unprivileged `sandbox` user; only the egress script is allowed via sudo.
set -euo pipefail

# Install the egress policy before anything else can touch the network. If this
# fails we REFUSE to start — a Box without its firewall violates threat B and
# must never accept a Sandbox User (ADR 0001).
if ! sudo /usr/local/bin/apply-egress.sh; then
  echo "FATAL: could not apply egress policy; refusing to start the Box." >&2
  exit 1
fi

# The Preview contract (ticket 09), as USER-LEVEL memory rather than a
# per-Project CLAUDE.md: an imported Project almost always ships its own
# CLAUDE.md, which would otherwise bury this. Written on every start so it can
# never drift from the image (same property `core/preview.ts`'s previewDoc()
# was built for) — /home/sandbox is a named volume, so anything baked into the
# image at build time would freeze on first run instead. Overwritten, never
# appended: nothing here is the user's own text.
mkdir -p /home/sandbox/.claude
cat > /home/sandbox/.claude/CLAUDE.md <<'EOF'
# Preview in Claudebox

The user views web pages by clicking **Preview** in the Launcher, which opens
whatever is serving inside this Box in their Mac's browser.

For that to work:

1. Serve on one of these published ports: 3000, 4321, 5173, 8000, 8080.
2. Bind the server to **0.0.0.0**, not to localhost. A server bound to
   localhost (127.0.0.1) inside this Box is NOT reachable from the Preview
   button — the page will look dead. The Launcher already keeps the port off
   the LAN.

Examples:

```sh
python3 -m http.server 5173 --bind 0.0.0.0
npx vite --host 0.0.0.0 --port 5173
```

Then tell the user to click **Preview**.
EOF

# Serve the web console (Starlette → tmux) in the background, AFTER egress is up.
# Reachable only via the Launcher's loopback port-forward, never the LAN. Best
# effort: a terminal failure must not stop the Box from hosting Claude sessions.
/usr/local/bin/start-terminal.sh &

exec "$@"
