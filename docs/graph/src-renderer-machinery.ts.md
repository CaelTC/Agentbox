---
tags: [module, renderer]
---

# `src/renderer/machinery.ts`

The renderer's bridge, its machinery, and the rules it is forced to keep a second copy of. Pure DOM against the narrow `window.agentbox` bridge — no Node, Docker, or shell access anywhere in `renderer/`.  The FIRST of the renderer's classic scripts: index.html lists them in the order they must run, and everything below is what the rest of them lean on.

Layer: [[renderer]]
