# Claudebox Launcher

The double-clickable macOS app that is a Sandbox User's entire interface to
Claudebox (CONTEXT.md → "Launcher"). It hides Docker/Colima: it refreshes and
starts the Box, shows the Project home screen, drops the user into a Claude Code
session, and brokers Uploads and Web Preview.

## Layout

```
src/
  core/        Pure, framework-free logic — the tested heart of the Launcher.
               No Electron, no Docker; deterministic and unit-tested.
    config.ts      Load-bearing constants (Resource Cap, volume, image names).
    colima.ts      Colima start/status argument builders.
    box.ts         docker build/run/exec argument builders + no-host-mount guard.
    egress.ts      The Egress Policy rule-set (mirrors box/egress/apply-egress.sh).
    batteries.ts   Manifest of pre-baked runtimes (cross-checked vs the Dockerfile).
    startup.ts     Minimal-step startup orchestration planner.
    projects.ts    Project naming / creation / listing (Workspace-safe paths).
    upload.ts      Upload target resolution (collisions, path-safety).
    preview.ts     Loopback publish args, preview URL, served-port detection.
    templates.ts   Starter Template registry + instantiation.
    refresh.ts     Refresh-on-Launch decision (hash + rebuild-if-changed).
    session-window.ts  Session URL + funnel `docker exec` + session-window options.
  main/        Electron main process — the EFFECTS around the pure core. Runs
               Colima/Docker, brokers the Box-side Workspace, and opens a
               Project's session (funnel + the Launcher-owned session window,
               one per Project — reopening raises it rather than stacking).
  renderer/    The home screen + per-Project control panel. The Claude session
               itself opens in a separate window, not in here — and only when
               the user clicks Open session.
  shared/      The typed IPC contract (ClaudeboxApi) between main and renderer.
  preload.ts   contextBridge exposing only ClaudeboxApi to the renderer.
  types/       Ambient Electron declaration (see "The Electron shim" below).
test/          Vitest unit tests for every core module + pure main helpers.
install/       The one-time Install Script — install.sh (macOS, ticket 09) and
               install.ps1 (Windows, issue #11). Same contract, same steps.
```

The split is deliberate: **`core/` holds the decisions and is fully tested**;
`main/` holds the un-testable-in-CI effects (Docker, native dialogs, pty) and is
kept thin so little logic escapes the tests.

**Two deliberate notes for reviewers:**

- `core/projects.ts` and `core/upload.ts` include a **local-filesystem reference
  implementation** (`createProject`, `listProjects`, `performUpload`, …) that the
  unit tests exercise as an executable spec of the naming/collision/metadata
  rules. In production the Workspace is a named volume with no host mirror
  (ADR 0001), so `main/workspace.ts` brokers the *same* rules into the Box via
  `docker exec`/`docker cp`, reusing the pure helpers (`sanitizeProjectName`,
  `resolveUploadTargets`, `serializeProjectMeta`). The decisions live in one
  place; only the effect target differs.
- Web Preview publishes a fixed set of common dev-server ports
  (`PREVIEW_PORTS`). A server on some other port won't be auto-detected — the
  Starter Templates steer Claude to a published port (e.g. 5173).

## Develop

```bash
npm install       # TypeScript + Vitest (dev only)
npm run typecheck # tsc --noEmit
npm test          # vitest run
```

## Runtime dependencies of the packaged app

The built macOS app depends on **electron** (the app shell), which is **not
needed for typechecking or tests** and is therefore not a runtime dependency in
this repo. The Claude session opens in a **BrowserWindow the Launcher owns**, so
no browser is a dependency of it at all — the Install Script installs none, and
Preview goes to whatever the host already treats as default. That window loads
the Box's page with no preload, no Node and a sandboxed renderer, and is held to
the console's own origin — the Box is the untrusted side of the boundary even
when the Launcher is the one drawing it. There is no embedded
terminal — the session is viewed
through the Box's loopback-forwarded web console, so no `node-pty`/`xterm`.

### The Electron shim

`src/types/electron.d.ts` declares the exact slice of the Electron API the main
process uses. It exists so this repo type-checks in a headless Linux CI box
without pulling the ~100 MB Electron binary. **When packaging for macOS**, run
`npm install electron` and delete the shim — Electron ships its own types, and
keeping both would double-declare the `electron` module.

## Packaging (macOS)

1. `npm install electron && rm src/types/electron.d.ts`
2. `npm run build` (emits `dist/`).
3. Bundle with your Electron packager of choice into `Claudebox.app`
   (`npm run package` wraps electron-packager).

No code signing is required to run it locally (ADR 0002).

## Packaging for Windows — from the same Mac

```bash
npm run package:win        # → release/Claudebox-win32-x64/Claudebox.exe
```

electron-packager cross-builds to win32 by downloading the win32 Electron
binary, so **one build host packages both platforms** — a provisioning script
should not need a Node toolchain and a multi-minute `npm install` on every
machine it touches.

Two deliberate omissions: no `--icon` and no `--win32metadata`. Both are written
into the exe by `rcedit`, which needs Wine on a Mac. The cost is the default
Electron icon, accepted for now rather than adding a build dependency.

`install.ps1` installs this folder by copying it (plus a Start Menu `.lnk` via
`WScript.Shell`) — the direct mirror of `install_launcher()` on the Mac, not an
NSIS/electron-builder installer. A script-copied exe also carries no
Mark-of-the-Web, so it dodges the SmartScreen prompt an unsigned *downloaded*
installer would trigger. Commit the built folder into the definition repo as
`launcher/Claudebox-win32-x64` for `install.ps1` to find, as with
`Claudebox.app` on the Mac.

`npm run assets` is plain Node (`fs.cpSync`) rather than `cp -R`, so `npm run
build` works from either OS.
