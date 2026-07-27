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

## Plugin pre-install

The mattpocock-skills plugin is provisioned in two places, and needs both:

- **`Dockerfile`** bakes it into the image, so a Box built from scratch has the
  skills before its first session.
- **`entrypoint.sh`** re-checks it on every start. `/home/sandbox` is a named
  volume, so a Box whose home volume already existed never picks up a change to
  the bake — the entrypoint is what reaches those Boxes.

The invocation itself is exact and was wrong for a while, silently:

```sh
claude plugin marketplace add https://github.com/mattpocock/skills.git
claude plugin install mattpocock-skills@mattpocock --scope user
```

- The repo is `mattpocock/skills`; `mattpocock/mattpocock-skills` is a 404.
- The `owner/repo` shorthand clones over **SSH**, and the Box has no GitHub key,
  so only the HTTPS URL authenticates.
- The marketplace names itself `mattpocock`, so the id is
  `mattpocock-skills@mattpocock` — `@mattpocock-skills` resolves to nothing.
- There is no `--yes` flag on `plugin install`; the scope flag is `--scope user`.

The build step deliberately has no `|| true`: a Battery that fails to install
should break the build, not the Sandbox User's first session. The entrypoint
top-up *is* best-effort, so an unreachable GitHub cannot stop a Box from
starting — it prints a `WARN` instead.
