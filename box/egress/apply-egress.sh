#!/usr/bin/env bash
#
# apply-egress.sh — install the Egress Policy inside the Box (ticket 02).
#
# The public internet stays reachable; every private/local range and the host
# gateway are dropped. This is the network half of threat B, closed by
# construction (ADR 0001). Run once at container start by entrypoint.sh (via a
# tightly-scoped sudo rule). Must run as root.
#
# This mirrors launcher/src/core/egress.ts — that module is the tested source of
# truth for the rule ORDER and the blocked ranges; keep the two in sync.
set -euo pipefail

BLOCKED_CIDRS=(
  "10.0.0.0/8"
  "172.16.0.0/12"
  "192.168.0.0/16"
  "169.254.0.0/16"
)

# The host gateway — the Box's default route. Blocking it stops the Box reaching
# the laptop itself. Discovered at runtime; empty is tolerated (the CIDR blocks
# still cover typical gateways).
GATEWAY="$(ip route show default 2>/dev/null | awk '/default/ {print $3; exit}')"

# Start from a clean OUTPUT chain each launch so re-runs are idempotent.
iptables -F OUTPUT

# 1. Loopback — carries the embedded DNS resolver, so DNS keeps working.
iptables -A OUTPUT -o lo -j ACCEPT

# 2. Return traffic for connections we initiated.
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

# 3. Host gateway, blocked explicitly.
if [[ -n "${GATEWAY}" ]]; then
  iptables -A OUTPUT -d "${GATEWAY}" -j DROP
fi

# 4. Every private/reserved range, dropped.
for cidr in "${BLOCKED_CIDRS[@]}"; do
  iptables -A OUTPUT -d "${cidr}" -j DROP
done

# 5. Everything else — the public internet — is allowed.
iptables -A OUTPUT -j ACCEPT

echo "[egress] policy applied (gateway=${GATEWAY:-none}); public internet open, private ranges blocked."
