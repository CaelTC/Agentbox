# Claudebox

A local development sandbox for running Claude Code on a colleague's computer. It
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

Two processes live on the **host** (the Sandbox User's own computer); everything
else runs **inside the Box**, which is the security boundary (ADR 0001). The host
reaches the Box only over a loopback-only port forward (`127.0.0.1:7681`) — never
the LAN.

```
  Host: macOS or Windows (trusted)        The Box  (Docker container = the boundary)
  ────────────────────────────────        ─────────────────────────────────────────

  ┌─────────────────────────┐             entrypoint.sh
  │ Launcher (Electron)      │   docker      1. apply-egress.sh   (firewall first)
  │  · start Engine + Box    │──  exec  ──▶  2. start-terminal.sh (web console)
  │  · Project home screen   │  claudebox-   3. sleep infinity    (stays alive)
  │  · per-Project controls  │   session
  │  · quit ⇒ docker stop    │   <slug>    web console  (server.py / Starlette, :7681)
  └───────────┬─────────────┘               GET  /sessions/<slug>          terminal page
              │                             WS   /sessions/<slug>/terminal  ─┐
              │ BrowserWindow.loadURL(      GET  /sessions/<slug>/files      │ read-only
              │   http://localhost:7681/sessions/<slug> )                    │
              ▼                                                              ▼
  ┌─────────────────────────┐  WS, :7681   claudebox-session <slug>   ── THE funnel ──
  │ Session window          │◀═ loopback ═▶  · validate slug shape
  │  (Launcher-owned: no    │    only        · require .claudebox/project.json
  │   URL bar, one per      │                · tmux new-session -A -s <slug> \
  │   Project — reopening   │                    claude --dangerously-skip-permissions \
  │   raises it)            │                    [seedPrompt]        ← passed as one argv
  └─────────────────────────┘
                                                        │
                                             tmux ──────┴───────────────────────
                                               "portfolio"      → claude
                                               "guessing-game"  → claude   (one per Project)

                                             Named volumes (persist across restart/rebuild):
                                               /workspace/<slug>/…      Workspace (the Projects)
                                               /home/sandbox            Login-with-Claude token
```

The **Engine** in that first box is the host's headless, licence-free container
runtime: Colima on macOS, a rootful Podman machine over WSL2 on Windows. The Box,
the firewall and everything to the right of the arrow are identical on both — what
differs is that the Windows Engine cannot enforce a disk ceiling, so the Resource
Cap is documented rather than bounded there
([ADR 0004](./docs/adr/0004-windows-runs-on-rootful-podman-wsl2-without-a-disk-cap.md)).

**`claudebox-session` is the single source of truth for launching a Project.**
Both the browser (via the web console's WebSocket) and the Launcher (via
`docker exec`) reach a Project's Claude *only* through this one program, driven
entirely by data on the Workspace volume — so an unknown or crafted slug can
never spawn anything. It runs Claude with permissions bypassed because the
container, not a per-action prompt, is the wall (ADR 0001).

### Opening a Project (end to end)

1. In the Launcher, the Sandbox User clicks a Project (or a Starter Template).
2. The Launcher ensures the Box is up, writes the Project's `CLAUDE.md` if it is
   missing (the Web Preview contract: serve on a published port, bind `0.0.0.0`),
   then runs `docker exec <box> claudebox-session <slug>` — off a TTY the funnel just
   **ensures** the tmux session exists (creating it detached, seeding the first
   prompt on a fresh session only).
3. Its own window becomes a per-Project control panel. Nothing else happens
   until the user clicks **Open session** — landing on the panel is also how
   they reach Upload, Save and Preview, so the session is opened when it is
   asked for, not every time the Project is.
4. **Open session** shows `http://localhost:7681/sessions/<slug>` in a window
   the Launcher owns: no URL bar, no tabs, and one per Project — clicking it
   again raises the window that is already open instead of stacking a second
   view of the same session on top of it.
5. That page opens a WebSocket to the web console, which runs
   `claudebox-session <slug>` **on a pty** — this time the funnel **attaches**
   to the (already-created) session. Keystrokes and output stream over the
   socket; the session lives in tmux, so closing the window leaves it running.
6. Clicking **Open session** after closing that window is step 4 again — the
   funnel re-attaches the live session without reseeding.

A session is a tmux session, and tmux is the source of truth — there is no
separate session state to keep in sync. Persistence is two named volumes: the
**Workspace** (`/workspace`, the user's Projects) and the sandbox **home**
(`/home/sandbox`, the Login-with-Claude token). Both survive Box stop/restart
and image rebuilds; neither is a host mount (ADR 0001, threat A).

Three more paths cross the boundary above, none through the loopback port —
the Launcher brokers each of them directly via `docker exec`/`docker cp`,
never a live mount (ADR 0001). **Upload** copies individual files host→Box
into an existing Project. **Export** copies a Project's documents Box→host
under an allowlist (ADR 0003). **Import** copies a whole folder host→Box,
becoming a new Project outright, unfiltered but for `.gitignore` — its
contents land at the Project root because `claudebox-session` above always
starts Claude there ([ADR 0005](./docs/adr/0005-import-is-a-whole-project-not-a-filtered-copy.md)).

## Layout

```
box/         The Box — the public Docker image.
  Dockerfile        Batteries (Node/Python/Rust/git) + Claude Code + the console.
  entrypoint.sh     Egress firewall → web console → stay alive.
  bin/claudebox-session   The funnel: slug → tmux → Claude (single source of truth).
  egress/           The Egress Policy (iptables rules).
  terminal/         The web console — Starlette app (server.py) + templates + paths.
scripts/     claudebox.sh — the walking-skeleton launcher (ticket 01).
launcher/    The Launcher app — macOS and Windows (Electron + TypeScript, tickets 04–09).
             Its src/core holds the pure, unit-tested logic for the whole system.
docs/adr/    Architecture Decision Records.
.scratch/    The originating tickets.
```

## Installing

The Install Script runs **once, on the machine being provisioned, by whoever
provisions it** — never by the Sandbox User. It installs the Engine, Google
Chrome, the initial Box image and the Launcher,
and it configures **no credential anywhere**: the definition repo is public, so
there is no secret to leak (ADR 0002).

### macOS

```bash
./launcher/install/install.sh
```

The Engine is Colima. No elevation is needed beyond Homebrew's own prompts.

### Windows

The Engine is **podman** on a WSL2 machine (Colima is macOS-only, and Docker
Desktop reintroduces the licence Colima was chosen to avoid).

**`install.ps1` must be run as Administrator.** This is a real difference from
the Mac: `wsl --install` and several winget packages need it. Run it from the
Sandbox User's own account, elevating when Windows asks, so the Launcher and its
Start Menu entry land in that user's profile.

```powershell
powershell -ExecutionPolicy Bypass -File launcher\install\install.ps1
```

It performs nine steps, all of them safely re-runnable:

1. Require Administrator.
2. Ensure WSL2. **On a machine that has never had WSL2, this enables it and then
   stops with "restart Windows and run this script again".** That restart is
   unavoidable; after it, re-running the script carries on from where it left off.
3. `winget install` podman, git and Chrome (skipping any already present).
4. Write `%USERPROFILE%\.wslconfig` with the Resource Cap's CPU/memory. Two
   honest limits here: `.wslconfig` applies to *every* WSL distro on the machine,
   and it has no disk ceiling — so on Windows the Resource Cap does not yet bound
   disk the way it does on the Mac.
5. Clone the public definition repo to `%USERPROFILE%\.claudebox\definition`
   over HTTPS, with no authentication.
6. `podman machine init` at the cap → `podman machine set --rootful` → `start`.
7. `podman build` the Box image.
8. Run `box/egress/verify-egress.sh` inside a throwaway Box. **If the Egress
   Policy does not hold, the install stops here** — a Box that cannot keep
   itself off the laptop and the LAN must never accept a Sandbox User.
9. Copy the Launcher to `%LOCALAPPDATA%\Programs\Claudebox` and create a Start
   Menu shortcut.

Step 9 needs a prebuilt Launcher folder (`launcher/Claudebox-win32-x64`),
cross-packaged from a Mac with `npm run package:win` — see `launcher/README.md`.
Without it the script says so and finishes; everything else is already in place.

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
