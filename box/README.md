# The Box

The Docker image that is Claudebox at runtime (CONTEXT.md → "The Box"). This
directory is the Docker build context and is intentionally **public** — it
contains no secrets (ADR 0002).

## Contents

- `Dockerfile` — builds the Box: Claude Code (ticket 01), the Batteries
  (Node/Python/Rust/git + the mattpocock-skills plugin, ticket 03), and the
  egress tooling (ticket 02).
- `entrypoint.sh` — applies the egress firewall exactly once at container start,
  then runs the container command. **Refuses to start** if the firewall can't be
  installed — a Box without its egress policy must never accept a Sandbox User.
- `egress/apply-egress.sh` — installs the Egress Policy with `iptables`. Mirrors
  the tested rule-set in `launcher/src/core/egress.ts`; keep the two in sync.
- `egress/verify-egress.sh` — the live proof, run from inside the Box: curls the
  gateway, a LAN address, a CGNAT address and one public URL, and reports
  whether the walls actually hold under this engine. "Rules installed" is not
  "host unreachable", and the topology differs between Colima and WSL2.

## Verifying the walls

```sh
docker run --rm --cap-add NET_ADMIN \
  --sysctl net.ipv6.conf.all.disable_ipv6=1 \
  --sysctl net.ipv6.conf.default.disable_ipv6=1 \
  claudebox:latest /usr/local/bin/verify-egress.sh
```

Run once by the Install Script after the image is built — **not** from
`entrypoint.sh`: a per-start self-check would be stronger, but one false
negative (flaky DNS, a captive portal) would brick the Box for a non-technical
user with no recourse. Because the entrypoint applies the firewall before
handing off, that single command also proves `NET_ADMIN`, in-container
`iptables` and the IPv6 sysctls work under whatever engine is hosting the Box.

Exit 0 means the walls hold *or* the machine is offline (it says which); exit 1
means the public internet is reachable **and** so is something private — a
breach, and the installer must stop.

## Run model

The Box runs long-lived (`sleep infinity`) so the Launcher exec's Claude
sessions into it; individual sessions come and go while the Workspace (a named
volume) and the Box persist. It needs `--cap-add NET_ADMIN` so the entrypoint
can install the firewall.

## Plugin pre-install caveat

The Dockerfile pre-installs the mattpocock-skills plugin so its skills are
available with no per-session setup (ticket 03). The exact `claude plugin …`
invocation depends on the Claude Code plugin CLI available at build time; the
step is written defensively (it warns rather than failing the build) and is the
single place to adjust if the CLI surface changes.
