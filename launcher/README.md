# Agentbox Launcher

The double-clickable macOS app that is a Sandbox User's entire interface to
Agentbox (CONTEXT.md → "Launcher"). It hides Docker/Colima: it refreshes and
starts the Box, shows the Project home screen, drops the user into a Claude Code
session, and brokers Uploads and Web Preview.

## Layout

```
src/
  core/        Pure, framework-free logic — the tested heart of the Launcher.
               No Electron, no Docker; deterministic and unit-tested.
    config.ts      Load-bearing constants (Resource Cap, volume, image names).
    box.ts         docker build/run/exec argument builders + no-host-mount guard.
    egress.ts      The Egress Policy rule-set (mirrors box/egress/apply-egress.sh).
    batteries.ts   Manifest of pre-baked runtimes (cross-checked vs the Dockerfile).
    startup.ts     Minimal-step startup orchestration planner.
    projects.ts    Project naming / creation / listing (Workspace-safe paths).
    upload.ts      Upload target resolution (collisions, path-safety).
    preview.ts     Loopback publish args, preview URL, served-port detection.
    refresh.ts     Refresh-on-Launch decision (hash + rebuild-if-changed).
    session-window.ts  Session URL + funnel argv + session-window options.
  main/        Electron main process — the EFFECTS around the pure core. Holds
               the Engine seam (engine.ts + its colima.ts / podman.ts adapters)
               and the Box-exec seam (box-exec.ts), brokers the Box-side
               Workspace (workspace.ts is a barrel over the workspace-*.ts
               concern modules: projects, upload, export, import, delete), and
               opens a Project's session (funnel + the Launcher-owned session
               window, one per Project — reopening raises it rather than
               stacking).
  renderer/    The home screen + per-Project control panel, one classic
               <script> per screen (machinery, layout, home, project, files,
               file-delete, app) sharing a single global scope — index.html
               lists them in the order they must run, and a renderer source
               missing from that list is dead code. The Claude session itself
               opens in a separate window, not in here — and only when the
               user clicks Open session.
  shared/      The typed IPC contract (AgentboxApi) between main and renderer.
  preload.ts   contextBridge exposing only AgentboxApi to the renderer.
  types/       Ambient Electron declaration (see "The Electron shim" below).
test/          Vitest unit tests for every core module + pure main helpers.
install/       The one-time Install Script — install.sh (macOS, ticket 09) and
               install.ps1 (Windows, issue #11). Same contract, same steps.
```

The split is deliberate: **`core/` holds the decisions and is fully tested**;
`main/` holds the un-testable-in-CI effects (Docker, native dialogs, pty) and is
kept thin so little logic escapes the tests.

**Two deliberate notes for reviewers:**

- The Workspace is a named volume with no host mirror (ADR 0001), so there is no
  host-side Project filesystem at all: the `main/workspace*.ts` modules are the
  only things that create, list, or write into Projects, brokering every
  operation into the Box via `docker exec`/`docker cp`. `core/projects.ts` and
  `core/upload.ts` hold only the pure rules they reuse (`sanitizeProjectName`,
  `assertValidSlug`, `resolveUploadTargets`,
  `serializeProjectMeta`), which the unit tests exercise
  as an executable spec of the naming/collision/metadata rules.
- Web Preview publishes a fixed set of common dev-server ports
  (`PREVIEW_PORTS`). A server on some other port won't be auto-detected — the
  Project's `CLAUDE.md` steers Claude to a published port (e.g. 5173).

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

## Packaging

```bash
npm run package        # → release/Agentbox-darwin-<arch>/Agentbox.app
npm run package:win    # → release/Agentbox-win32-x64/Agentbox.exe
```

No code signing is required to run either locally (ADR 0002) — and *locally* is
load-bearing. **The Install Scripts run these themselves**, on the machine being
provisioned: `install.sh` calls `npm run package` and `install.ps1` calls `npm
run package:win`, each after `npm ci` in the freshly cloned `launcher/`. Nothing
prebuilt is committed or downloaded, so there is no build artefact in this repo
to keep in step with the source.

The build has to happen on the target machine rather than once on a build host,
because an unsigned bundle that arrives over HTTPS is quarantined: macOS marks
it `com.apple.quarantine` and refuses to open it; Windows gives it the
Mark-of-the-Web and SmartScreen prompts. A bundle built and copied by a script
on the machine itself carries neither. Signing would be the other way out, and
ADR 0002 rules it out.

`npm run package` takes the host arch, so a provisioner's Intel Mac gets an x64
`.app` — hence the `*` in install.sh's copy. `package:win` pins x64 whether it
runs on Windows (native) or cross-builds from a Mac; electron-packager downloads
the win32 Electron binary for the latter.

Two deliberate omissions on Windows: no `--icon` and no `--win32metadata`. Both
are written into the exe by `rcedit`, which needs Wine when cross-building from
a Mac. The cost is the default Electron icon, accepted for now rather than
adding a build dependency that only one of the two build paths needs.

`install.ps1` installs the built folder by copying it (plus a Start Menu `.lnk`
via `WScript.Shell`) — the direct mirror of `install_launcher()` on the Mac, not
an NSIS/electron-builder installer.

`npm run assets` is plain Node (`fs.cpSync`) rather than `cp -R`, so `npm run
build` works from either OS.
