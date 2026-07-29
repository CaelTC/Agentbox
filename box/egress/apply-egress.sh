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
# truth for the rule ORDER and the blocked ranges. The two cannot drift quietly:
# launcher/test/egress.test.ts ("the Egress Policy's two copies") unrolls the
# loops below and compares this script's rules, in order, against the ones
# egressPolicyRules() generates.
set -euo pipefail

BLOCKED_CIDRS=(
  "10.0.0.0/8"
  "172.16.0.0/12"
  "192.168.0.0/16"
  "169.254.0.0/16"
  "100.64.0.0/10"
)

# The host gateway — the Box's default route. Blocking it stops the Box reaching
# the laptop itself. Discovered at runtime; empty is tolerated (the CIDR blocks
# still cover typical gateways).
GATEWAY="$(ip route show default 2>/dev/null | awk '/default/ {print $3; exit}')"

# Fail CLOSED: set the default policy to DROP BEFORE touching the rules, so any
# partial, interrupted, or maliciously re-triggered run (the sandbox user may
# re-invoke this via sudo) leaves egress denied rather than wide open. The flush
# then rebuilds the allow/deny rules on top of a deny-by-default chain.
iptables -P OUTPUT DROP
iptables -F OUTPUT

# 1. Loopback — under Docker Desktop this carries the embedded DNS resolver.
iptables -A OUTPUT -o lo -j ACCEPT

# 2. Return traffic for connections we initiated.
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

# 2b. DNS to the container's configured resolver(s). Under Colima the resolver is
#     the gateway (e.g. 192.168.5.1) — inside a blocked range below — so without
#     this every name lookup is dropped and the Box is offline. Port 53 ONLY:
#     opens no other access to that host, and the gateway/CIDR DROPs below still
#     block all non-DNS traffic to it even when the resolver IS the gateway.
for ns in $(awk '/^nameserver/ {print $2}' /etc/resolv.conf 2>/dev/null); do
  iptables -A OUTPUT -d "${ns}" -p udp --dport 53 -j ACCEPT
  iptables -A OUTPUT -d "${ns}" -p tcp --dport 53 -j ACCEPT
done

# 2c. The Database network (created by the Launcher / scripts/agentbox.sh with
#     this pinned subnet). Postgres' port — and ONLY that port — is reachable
#     there; the rest of the subnet stays inside the 172.16/12 DROP below.
#     Literal on purpose: the drift test compares this line verbatim against
#     core/egress.ts, whose DB_SUBNET/DB_PORT carry the same values.
iptables -A OUTPUT -d 172.30.0.0/24 -p tcp --dport 5432 -j ACCEPT

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

# 6. IPv6: the Launcher disables IPv6 on the Box's interfaces (--sysctl
#    disable_ipv6=1), so there is no v6 path to bypass the IPv4 rules above. This
#    is the in-Box backstop — deny ALL v6 egress. Best-effort: never abort startup
#    if the v6 stack/module is absent (the sysctl is the hard guarantee).
if command -v ip6tables >/dev/null 2>&1; then
  ip6tables -P OUTPUT DROP            2>/dev/null || true
  ip6tables -F OUTPUT                 2>/dev/null || true
  ip6tables -A OUTPUT -o lo -j ACCEPT 2>/dev/null || true
fi

echo "[egress] policy applied (gateway=${GATEWAY:-none}); default-drop, public internet open, private+CGNAT+IPv6 blocked."
