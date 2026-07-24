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

## Layout

```
box/         The Box — the public Docker image (Dockerfile, egress, entrypoint).
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
