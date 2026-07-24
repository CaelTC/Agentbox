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
  main/        Electron main process — the EFFECTS around the pure core.
               Runs Colima/Docker, brokers the Box-side Workspace, hosts the pty.
  renderer/    The home screen + in-Project session view (xterm terminal).
  shared/      The typed IPC contract (ClaudeboxApi) between main and renderer.
  preload.ts   contextBridge exposing only ClaudeboxApi to the renderer.
  types/       Ambient Electron declaration (see "The Electron shim" below).
test/          Vitest unit tests for every core module + pure main helpers.
install/       The one-time Install Script (ticket 09).
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

The built macOS app additionally depends on three packages that are **not needed
for typechecking or tests** and are therefore not installed in this repo:

- **electron** — the app shell.
- **node-pty** — hosts the interactive Claude session's pseudo-terminal.
- **xterm** (`xterm`, `xterm.css`) — renders the terminal; vendored into
  `renderer/` at build time and exposed as the global `Terminal`.

`node-pty` and `xterm` are reached via runtime `require` / a browser global, so
they impose no compile-time coupling.

### The Electron shim

`src/types/electron.d.ts` declares the exact slice of the Electron API the main
process uses. It exists so this repo type-checks in a headless Linux CI box
without pulling the ~100 MB Electron binary. **When packaging for macOS**, run
`npm install electron` and delete the shim — Electron ships its own types, and
keeping both would double-declare the `electron` module.

## Packaging (macOS)

1. `npm install electron node-pty xterm && rm src/types/electron.d.ts`
2. Vendor `xterm.js` / `xterm.css` into `src/renderer/`.
3. `npm run build` (emits `dist/`).
4. Bundle with your Electron packager of choice into `Claudebox.app`.

No code signing is required to run it locally (ADR 0002).
