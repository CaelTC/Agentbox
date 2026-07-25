#!/bin/sh
#
# verify-egress.sh — prove the Egress Policy actually holds, from inside the Box
# (issue #11).
#
# apply-egress.sh installs the rules and launcher/src/core/egress.ts asserts the
# rule DATA in unit tests, but neither shows that the host is genuinely out of
# reach from in here: "rules installed" is not "walls hold". The topology differs
# per engine — Colima on the Mac, a WSL2 machine under podman on Windows, with a
# different gateway, a DNS proxy, and possibly networkingMode=mirrored — so this
# script measures the wall instead of trusting it.
#
# Run ONCE by the Install Script after the image is built, deliberately NOT from
# entrypoint.sh. A per-start self-check would be a stronger guarantee, but a
# single false negative (flaky DNS, a captive portal) would brick the Box for a
# non-technical user with no recourse.
#
# Exit 0 — the walls hold, OR the machine is offline (skipped, and says why).
# Exit 1 — BREACHED: something private answered. Checked before the offline
#          case, because a private address answering is a breach whether or not
#          the public internet is up. The installer hard-fails on this (threat B).
set -eu

log() { echo "[verify-egress] $*"; }

# The public target. Reachability here is what separates "the walls hold" from
# "this machine has no network at all" — it is not itself part of the policy.
PUBLIC_URL="${PUBLIC_URL:-https://github.com}"

# The host gateway — the Box's default route, i.e. the laptop itself. Discovered
# the same way apply-egress.sh discovers it, so the two agree on what "the
# gateway" is under whatever engine is running.
GATEWAY="$(ip route show default 2>/dev/null | awk '/default/ {print $3; exit}')"

# One representative address per blocked class the Box must never reach: a
# typical LAN gateway, and Tailscale's 100.64.0.0/10 (CGNAT — the mesh-VPN path
# to company systems that is NOT RFC-1918). Neither is expected to exist; the
# point is that the attempt must not complete.
LAN_PROBE="${LAN_PROBE:-192.168.1.1}"
CGNAT_PROBE="${CGNAT_PROBE:-100.100.100.100}"

CONNECT_TIMEOUT=3
MAX_TIME=6

# Classify one probe. `--noproxy '*'` is load-bearing: an http_proxy in the
# environment would send every probe to the proxy instead of the address we are
# testing, and the result would mean nothing.
#
# Only a COMPLETED TCP connection counts as reachable. curl cannot distinguish a
# refusal (the packet reached a live host, which would be a breach) from "no
# route to host" (which is fine) — both are exit 7 — so exit 7 is reported but
# not treated as a breach. This makes the check a floor, not a proof of every
# path: it can never fail the install on an ambiguous signal, and a dropped
# packet (exit 28, the shape our DROP rules produce) is named as such in the log.
probe() {
  _rc=0
  curl -s -o /dev/null --noproxy '*' \
    --connect-timeout "$CONNECT_TIMEOUT" --max-time "$MAX_TIME" "$1" 2>/dev/null || _rc=$?
  case "$_rc" in
    0 | 52) echo "reachable" ;;   # 52 = connected, empty reply: the handshake completed
    6)      echo "no-dns" ;;      # the name did not resolve
    28)     echo "dropped" ;;     # timed out: the shape a DROP rule produces
    *)      echo "no-connection" ;;
  esac
}

# --- The private targets -----------------------------------------------------
breach=""

check_private() {
  _name="$1"
  _url="$2"
  _verdict="$(probe "$_url")"
  log "  ${_name} (${_url}): ${_verdict}"
  if [ "$_verdict" = "reachable" ]; then
    breach="${breach} ${_name}"
  fi
}

log "Checking the Egress Policy from inside the Box…"

if [ -n "$GATEWAY" ]; then
  check_private "host gateway" "http://${GATEWAY}/"
else
  log "  host gateway: no default route to test"
fi
check_private "LAN address" "http://${LAN_PROBE}/"
check_private "CGNAT address" "http://${CGNAT_PROBE}/"

# --- The public target -------------------------------------------------------
public="$(probe "$PUBLIC_URL")"
log "  public internet (${PUBLIC_URL}): ${public}"

# --- Verdict, fail-closed ----------------------------------------------------
# The breach check comes FIRST, before the offline branch. A private address
# answering is a breach on its own terms — the public target only ever told us
# whether "nothing answered" means the walls hold or the machine has no network,
# and it has no bearing on something that DID answer. Checking it the other way
# round certifies the exact case threat B lives in: a corporate LAN whose gateway
# replies while github.com is blocked would read as "offline, skipped, exit 0".
if [ -n "$breach" ]; then
  log "BREACHED:${breach} answered from inside the Box." >&2
  log "The Egress Policy is NOT holding under this engine — threat B is open." >&2
  exit 1
fi

if [ "$public" != "reachable" ]; then
  # Offline is not a breach. Skip rather than fail: an installer that refused to
  # finish on a train would be worse than useless. "Nothing private answered" is
  # now true by construction — the breach check above already exited if it had.
  if [ "$public" = "no-dns" ]; then
    log "SKIPPED: no DNS. If this machine IS online, apply-egress.sh rule 2b is"
    log "         not covering this engine's resolver and the Box is silently offline."
  else
    log "SKIPPED: the public internet is unreachable, so this machine is offline."
    log "         Nothing private answered either. Re-run when it is online."
  fi
  exit 0
fi

log "OK: the public internet is reachable and nothing private is."
exit 0
