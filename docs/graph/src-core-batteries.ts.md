---
tags: [module, core]
---

# `src/core/batteries.ts`

[[Batteries]] (CONTEXT.md): the tooling pre-baked into the Box so Claude can act instantly with no per-session installs (ticket 03).  This manifest is the single declaration of what the image must ship. The test suite cross-checks each entry against box/Dockerfile so the two cannot drift: if a runtime is dropped from the Dockerfile, the batteries test goes red.

Layer: [[core]]

- implements [[Batteries]]
- tested by `launcher/test/batteries.test.ts`
