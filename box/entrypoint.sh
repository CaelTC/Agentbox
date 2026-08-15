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
# per-Project doc: an imported Project almost always ships its own AGENTS.md or
# CLAUDE.md, which would otherwise bury this. One doc serves both harnesses —
# Codex reads ~/.codex/AGENTS.md as its global instructions, Claude Code reads
# ~/.claude/CLAUDE.md — so the Claude path is a symlink to the AGENTS.md rather
# than a second copy that could drift. Written on every start so it can
# never drift from the image (same property `core/preview.ts`'s previewDoc()
# was built for) — /home/sandbox is a named volume, so anything baked into the
# image at build time would freeze on first run instead. Overwritten, never
# appended: nothing here is the user's own text.
mkdir -p /home/sandbox/.codex /home/sandbox/.claude
cat > /home/sandbox/.codex/AGENTS.md <<'EOF'
# Preview in Agentbox

The user views web pages by clicking **Preview** in the Launcher, which opens
whatever is serving inside this Box in their computer's browser.

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

# Database in Agentbox

A PostgreSQL server is already running beside this Box on a private docker
network. Whenever a project needs a database, USE IT — do not install postgres,
mysql, or another server, and do not reach for sqlite because a database
"isn't available". It is:

    postgresql://postgres:postgres@agentbox-postgres:5432/postgres

Create one database per project (`CREATE DATABASE <project>`) rather than
sharing `postgres`. It is reachable only from inside this Box, and its data
survives restarts.
EOF
# -f, so a Box whose home volume predates this change — a real CLAUDE.md file
# sits there — is converted to the symlink instead of keeping stale text.
ln -sf /home/sandbox/.codex/AGENTS.md /home/sandbox/.claude/CLAUDE.md

# The mattpocock-skills Battery (ticket 03). The Dockerfile bakes it into the
# image, but /home/sandbox is a named volume: a Box whose home volume was
# created before the bake — or while the bake was still installing the wrong
# plugin id — keeps its empty ~/.claude/plugins forever. So top it up here on
# every start, for the same reason the AGENTS.md above is rewritten every start.
# Backgrounded and best-effort: a slow or unreachable GitHub must never delay
# the Box, and after the first success the check costs one `plugin list`.
provision_skills() {
  if claude plugin list 2>/dev/null | grep -q "mattpocock-skills@mattpocock"; then
    return 0
  fi
  # Adding an already-known marketplace is an error, not a no-op, so the install
  # must not be chained behind it.
  claude plugin marketplace add https://github.com/mattpocock/skills.git >/dev/null 2>&1 || true
  claude plugin install mattpocock-skills@mattpocock --scope user >/dev/null 2>&1 \
    || echo "WARN: could not provision mattpocock-skills; see box/README.md" >&2
}
provision_skills &

# Codex's "Sign in with ChatGPT" runs its OAuth callback server on
# 127.0.0.1:1455 INSIDE the Box, which the Launcher's published port cannot
# reach: Docker forwards to the Box's bridge (eth0) address, never container
# loopback (the same gap the Preview doc above closes by telling servers to
# bind 0.0.0.0 — Codex's bind is not configurable, so it gets a bridge
# instead). Forward bridge-ip:1455 → 127.0.0.1:1455 so the Mac's browser can
# complete the redirect. Bound to the bridge address SPECIFICALLY, never
# 0.0.0.0: a wildcard bind would collide with Codex's own 127.0.0.1:1455 and,
# while Codex isn't listening, would accept its own forwards in a loop. The
# host side stays loopback-only (the Launcher publishes 127.0.0.1:1455).
# Best-effort like the console below: no bridge must never stop the Box.
BRIDGE_IP="$(ip -4 route get 1.0.0.1 2>/dev/null \
  | awk '{for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit }}' || true)"
if [[ -n "${BRIDGE_IP}" ]]; then
  socat "TCP4-LISTEN:1455,bind=${BRIDGE_IP},fork,reuseaddr" TCP4:127.0.0.1:1455 &
fi

# Serve the web console (Starlette → tmux) in the background, AFTER egress is up.
# Reachable only via the Launcher's loopback port-forward, never the LAN. Best
# effort: a terminal failure must not stop the Box from hosting Claude sessions.
/usr/local/bin/start-terminal.sh &

exec "$@"
