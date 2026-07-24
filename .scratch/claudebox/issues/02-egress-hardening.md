# 02 — Egress hardening

**What to build:** From inside the Box, the public internet is reachable but the company LAN and the laptop's local network are not. This closes the network half of threat B by construction (see ADR 0001).

**Blocked by:** 01 — Walking skeleton. (Independent of #03; may proceed in parallel with it.)

**Status:** ready-for-agent

- [ ] Firewall rules block egress to all private/reserved ranges: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, and the host gateway.
- [ ] Public internet egress still works (e.g. a public HTTPS request succeeds).
- [ ] DNS resolution still works from inside the Box.
- [ ] A request to a private/LAN IP or the host from inside the Box fails.
