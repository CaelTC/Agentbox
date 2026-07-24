# Claudebox

A local development sandbox for running Claude Code on a colleague's MacBook. It
lets people who are not fluent in Git or coding safely practice and play with
Claude Code without risking their own machine or reaching company systems.

See [`CONTEXT.md`](./CONTEXT.md) for the ubiquitous language and the Threat Model.

## Why it's safe

Two decisions carry the safety of the whole system (see `docs/adr/`):

1. **The container is the permission boundary**
   ([ADR 0001](./docs/adr/0001-container-is-the-permission-boundary.md)) — no
   host mounts, egress blocked to all private/local ranges, and Claude Code runs
   with prompts bypassed because the walls are real.
2. **Public repo, no keys, refresh on launch**
   ([ADR 0002](./docs/adr/0002-public-repo-no-keys-refresh-on-launch.md)) — no
   company credential ever lands on the laptop or in the Box.

## Architecture

Two processes live on the **host** (the MacBook); everything else runs **inside
the Box**, which is the security boundary (ADR 0001). The host reaches the Box
only over a loopback-only port forward (`127.0.0.1:7681`) — never the LAN.

```
  MacBook (host, trusted)                 The Box  (Docker container = the boundary)
  ───────────────────────                 ─────────────────────────────────────────

  ┌─────────────────────────┐             entrypoint.sh
  │ Launcher (Electron)      │   docker      1. apply-egress.sh   (firewall first)
  │  · start Colima + Box    │──  exec  ──▶  2. start-terminal.sh (web console)
  │  · Project home screen   │  claudebox-   3. sleep infinity    (stays alive)
  │  · per-Project controls  │   session
  │  · quit ⇒ docker stop    │   <slug>    web console  (server.py / Starlette, :7681)
  └───────────┬─────────────┘               GET  /sessions/<slug>          terminal page
              │                             WS   /sessions/<slug>/terminal  ─┐
              │ open -na "Google Chrome"    GET  /sessions/<slug>/files      │ read-only
              │   --app=http://localhost:7681/sessions/<slug>                │
              ▼                                                              ▼
  ┌─────────────────────────┐  WS, :7681   claudebox-session <slug>   ── THE funnel ──
  │ Chrome app-mode window  │◀═ loopback ═▶  · validate slug shape
  │  (chromeless: no URL    │    only        · require .claudebox/project.json
  │   bar, no tabs)         │                · tmux new-session -A -s <slug> \
  └─────────────────────────┘                    claude --dangerously-skip-permissions \
                                                  [seedPrompt]        ← passed as one argv
                                                        │
                                             tmux ──────┴───────────────────────
                                               "portfolio"      → claude
                                               "guessing-game"  → claude   (one per Project)

                                             Named volumes (persist across restart/rebuild):
                                               /workspace/<slug>/…      Workspace (the Projects)
                                               /home/sandbox            Login-with-Claude token
```

**`claudebox-session` is the single source of truth for launching a Project.**
Both the browser (via the web console's WebSocket) and the Launcher (via
`docker exec`) reach a Project's Claude *only* through this one program, driven
entirely by data on the Workspace volume — so an unknown or crafted slug can
never spawn anything. It runs Claude with permissions bypassed because the
container, not a per-action prompt, is the wall (ADR 0001).

### Opening a Project (end to end)

1. In the Launcher, the Sandbox User clicks a Project (or a Starter Template).
2. The Launcher ensures the Box is up, then runs
   `docker exec <box> claudebox-session <slug>` — off a TTY the funnel just
   **ensures** the tmux session exists (creating it detached, seeding the first
   prompt on a fresh session only).
3. The Launcher opens `http://localhost:7681/sessions/<slug>` in a **chromeless
   Chrome app-mode window**, and its own window becomes a per-Project control
   panel. If Chrome is missing it falls back to the default browser.
4. That page opens a WebSocket to the web console, which runs
   `claudebox-session <slug>` **on a pty** — this time the funnel **attaches**
   to the (already-created) session. Keystrokes and output stream over the
   socket; the session lives in tmux, so closing the window leaves it running.
5. "Reopen terminal" is just step 3 again — the funnel re-attaches the live
   session without reseeding.

A session is a tmux session, and tmux is the source of truth — there is no
separate session state to keep in sync. Persistence is two named volumes: the
**Workspace** (`/workspace`, the user's Projects) and the sandbox **home**
(`/home/sandbox`, the Login-with-Claude token). Both survive Box stop/restart
and image rebuilds; neither is a host mount (ADR 0001, threat A).

## Layout

```
box/         The Box — the public Docker image.
  Dockerfile        Batteries (Node/Python/Rust/git) + Claude Code + the console.
  entrypoint.sh     Egress firewall → web console → stay alive.
  bin/claudebox-session   The funnel: slug → tmux → Claude (single source of truth).
  egress/           The Egress Policy (iptables rules).
  terminal/         The web console — Starlette app (server.py) + templates + paths.
scripts/     claudebox.sh — the walking-skeleton launcher (ticket 01).
launcher/    The macOS Launcher app (Electron + TypeScript, tickets 04–09).
             Its src/core holds the pure, unit-tested logic for the whole system.
docs/adr/    Architecture Decision Records.
.scratch/    The originating tickets.
```

## Working on it

The tested logic lives in `launcher/`:

```bash
cd launcher
npm install
npm run typecheck
npm test
```

The Box, firewall, and native/macOS pieces are authored here but exercised on a
real Mac with Colima + Docker — see `launcher/README.md` and `box/README.md` for
how they fit together and how to package the Launcher.

## Try the spine by hand (needs macOS + Colima + Docker)

```bash
./scripts/claudebox.sh
```
