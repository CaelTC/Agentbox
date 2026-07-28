# Project agent memory

Domain language and the rules the product is built on live in `CONTEXT.md` — read
it first. This file is only the sharp edges of working in the code.

## The renderer is a classic `<script>`

`launcher/src/renderer/app.ts` is compiled and loaded as a plain script, not a
module: an `import` or `export` anywhere in it makes tsc emit CommonJS the
browser cannot run, and the screen comes up blank with no build error. Anything
the renderer needs is either declared in that file or reached through
`window.agentbox`.

## The machinery region is the only renderer test seam

`test/renderer.test.ts` extracts the region between
`// --- the renderer's machinery ---` and its end marker by regex, compiles it
with esbuild, and runs it against a fake DOM. Nothing outside that region is
testable. So a new pure helper — a path filter, a total, a tree derivation —
goes *inside* the region and gets a unit test there; it does not go next to the
screen it draws.

Two functions in that region (`normalize`, `size`) are deliberate copies of
`core/delete.ts` and `core/format.ts`, and tests compare them as text. Change one
side and you change both.

## Comments state invariants

`app.ts` and `styles.css` record reasoning, not description — several comments
name an invariant the code below keeps (how many cards a grid holds, what may
open before the gate, why a value is host-side). Either keep the invariant or
update the comment to the new one. Silently breaking one is how the next reader
gets it wrong.

## Known-failing test

`test/exec.test.ts > run's deadline` fails on a clean tree on this machine — it
asserts wall-clock elapsed time and loses that race. Confirm any suspected new
failure by stashing before you chase it.
