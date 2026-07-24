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

exec "$@"
