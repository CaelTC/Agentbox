# The Box

The Docker image that is Agentbox at runtime (CONTEXT.md → "The Box"). This
directory is the Docker build context and is intentionally **public** — it
contains no secrets (ADR 0002).

## Contents

- `Dockerfile` — builds the Box: Claude Code (ticket 01) and Codex (the second
  Harness, ADR 0007), the Batteries (Node/Python/Rust/git + the
  mattpocock-skills plugin, ticket 03), and the egress tooling (ticket 02).
- `codex-skills/` — the same skills battery in the form Codex reads, since it
  can't install a Claude Code plugin (see `codex-skills/README.md`).
- `entrypoint.sh` — applies the egress firewall exactly once at container start,
  then writes the Box-global agent memory (`~/.codex/AGENTS.md`, with Claude
  Code's `~/.claude/CLAUDE.md` symlinked at it), lays down the skills and
  bridges Codex's OAuth callback port, then runs the container command. **Refuses to start** if the
  firewall can't be installed — a Box without its egress policy must never
  accept a Sandbox User; the bridge, by contrast, is best-effort.
- `bin/agentbox-session` — the funnel. Picks the agent named by the Project's
  `.agentbox/project.json` (absent means Claude Code) and starts it in tmux with
  its own guardrails off, because the container is the wall (ADR 0001, 0007).
  `python3 bin/test_seed.py` is its self-check.
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
  agentbox:latest /usr/local/bin/verify-egress.sh
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

The Box runs long-lived (`sleep infinity`) so the Launcher exec's agent
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

The same skills reach Codex by a different road — it has no plugins, and reads
`SKILL.md` directories out of `~/.agents/skills`. They are ported into
`codex-skills/`, copied to `/opt/codex-skills` in the image, and laid into the
home volume by the entrypoint on every start. See `codex-skills/README.md`.
