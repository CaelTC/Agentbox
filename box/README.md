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
