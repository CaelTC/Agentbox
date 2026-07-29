# Project agent memory

Domain language and the rules the product is built on live in `CONTEXT.md` — read
it first. This file is only the sharp edges of working in the code.

## The renderer is classic `<script>`s

Every `launcher/src/renderer/*.ts` is compiled and loaded as a plain script, not
a module: an `import` or `export` anywhere in one makes tsc emit CommonJS the
browser cannot run, and the screen comes up blank with no build error. They share
one global scope, and `index.html` lists them in the order they must run —
`machinery.ts` first, `app.ts` (the only one that runs anything as it loads)
last. A new renderer file needs a `<script>` tag there or it is dead code with a
green build; `test/renderer.test.ts` fails on both mistakes.

Anything the renderer needs is either declared in one of those files or reached
through `window.agentbox`.

## The machinery region is the only renderer test seam

`test/renderer.test.ts` extracts the region between
`// --- the renderer's machinery ---` and its end marker, in
`renderer/machinery.ts`, by regex, compiles it with esbuild, and runs it against
a fake DOM. Nothing outside that region is testable. So a new pure helper — a
path filter, a total, a tree derivation — goes *inside* the region and gets a
unit test there; it does not go next to the screen it draws, wherever that screen
now lives.

Two functions in that region (`normalize`, `size`) are deliberate copies of
`core/delete.ts` and `core/format.ts`, and tests compare them as text. Change one
side and you change both.

## `main/workspace.ts` is a barrel

It re-exports the five `main/workspace-*.ts` concern modules and holds no code of
its own. `main/ipc.ts` imports from it and `test/box-gate.test.ts` mocks exactly
that path, so a new Workspace operation goes in a concern module *and* gets a
line in the barrel — one import surface, named rather than `export *`.

## Comments state invariants

The renderer's files and `styles.css` record reasoning, not description — several
comments name an invariant the code below keeps (how many cards a grid holds,
what may open before the gate, why a value is host-side). Either keep the
invariant or update the comment to the new one. Silently breaking one is how the
next reader gets it wrong.

## Tests that spawn real processes

`test/exec.test.ts > run's deadline` spawns real children, and two costs it has
to clear are invisible in the source:

- **Resolution.** `run` hands the child a PATH `spawnPath` has just made longer,
  and the child scans it. ~45 entries cost ~180ms before `/bin/sh` is reached,
  against ~6ms for the absolute path — so spawn `/bin/sh`, never `sh`.
- **Startup.** Getting a process to its first line is single-digit ms idle and
  hundreds under the parallel suite. A deadline shorter than that signals a
  child that has not run yet, so assert the child reached the state under test
  (it says so on stdout) rather than assuming a short deadline let it.

Together these made that case look like an unwinnable wall-clock race, and hid a
real defect underneath: the deadline signalled only the direct child, so a
grandchild kept the stdout pipe — and `close`, and the promise — open. Measured
on that local `sh -c` case, not on a `docker exec`, whose shell runs inside the
container and holds no host fd: the group kill is defence in depth for host-side
helpers that fork. See the `killGroup` comment in `src/main/exec.ts`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
