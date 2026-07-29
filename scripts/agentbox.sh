#!/usr/bin/env bash
#
# agentbox.sh — the walking-skeleton launcher (ticket 01).
#
# Starts Colima at the Resource Cap, builds & runs the Box (with the Workspace
# on a named volume and NO host mounts), and drops you into a Claude Code
# session with permissions bypassed. The Launcher app (ticket 04) replaces this
# for day-to-day use; this script proves the spine end to end.
#
# The TypeScript core in launcher/src/core is the source of truth for these
# values. launcher/test/config.test.ts compares the `docker run` and
# `colima start` commands below against boxRunArgs() and colimaStartArgs(), so
# a value that drifts from the core fails a test rather than a launch.
set -euo pipefail

PROFILE="agentbox"
IMAGE="agentbox:latest"
CONTAINER="agentbox"
VOLUME="agentbox-workspace"
WORKSPACE_DIR="/workspace"
HOME_VOLUME="agentbox-home"
HOME_DIR="/home/sandbox"
BOX_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../box" && pwd)"

# Resource Cap (~4 CPU / 6 GB RAM / 25 GB disk). The disk cap bounds threat A.
CPU=4
MEMORY=6
DISK=25

log() { printf '\033[36m[agentbox]\033[0m %s\n' "$*"; }

require() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing dependency: $1. Run the Install Script first." >&2
    exit 1
  }
}

require colima
require docker

# 1. Engine: start Colima at the Resource Cap if it isn't already up.
if colima status --profile "$PROFILE" 2>&1 | grep -qi "is running"; then
  log "Colima already running."
else
  log "Starting Colima (${CPU} CPU / ${MEMORY} GiB / ${DISK} GiB)…"
  colima start --profile "$PROFILE" --cpu "$CPU" --memory "$MEMORY" --disk "$DISK"
fi

# Pin docker to the profile's own socket: without this every docker command
# below targets the current context (Docker Desktop, if installed) instead of
# the VM just started — same pin as engineEnv() in launcher/src/main/exec.ts.
export DOCKER_HOST="unix://$HOME/.colima/${PROFILE}/docker.sock"

# 2. Build the Box image.
log "Building the Box…"
docker build -t "$IMAGE" "$BOX_DIR"

# 3. Run the Box: detached, named-volume Workspace + home (login persistence),
#    no host mounts, NET_ADMIN so the entrypoint can install the egress firewall.
if docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  log "Box already running."
elif docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  # Restart the existing container so the Claude login survives (ticket 01).
  log "Restarting the Box…"
  docker start "$CONTAINER" >/dev/null
else
  log "Starting the Box…"
  docker run -d \
    --name "$CONTAINER" \
    --cap-add NET_ADMIN \
    --sysctl net.ipv6.conf.all.disable_ipv6=1 \
    --sysctl net.ipv6.conf.default.disable_ipv6=1 \
    -p 127.0.0.1:3000:3000 \
    -p 127.0.0.1:4321:4321 \
    -p 127.0.0.1:5173:5173 \
    -p 127.0.0.1:8000:8000 \
    -p 127.0.0.1:8080:8080 \
    -p 127.0.0.1:7681:7681 \
    -v "${VOLUME}:${WORKSPACE_DIR}" \
    -v "${HOME_VOLUME}:${HOME_DIR}" \
    "$IMAGE" \
    sleep infinity
fi

# 4. Drop the user into Claude Code with permissions bypassed.
log "Web terminal (tmux) at http://127.0.0.1:7681 — open it in your browser."
log "Entering Claude Code — type a prompt to talk to Claude."
exec docker exec -it -w "$WORKSPACE_DIR" "$CONTAINER" \
  claude --dangerously-skip-permissions
