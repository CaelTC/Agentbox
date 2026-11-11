---
tags: [layer]
---

# `renderer`

Classic `<script>`s sharing one global scope, loaded in the order `index.html` lists. No imports — anything host-side is reached through `window.agentbox` ([[src-preload.ts|src/preload.ts]]). Only the machinery region of `machinery.ts` is testable.

- [[src-renderer-app.ts|src/renderer/app.ts]]
- [[src-renderer-file-delete.ts|src/renderer/file-delete.ts]]
- [[src-renderer-files.ts|src/renderer/files.ts]]
- [[src-renderer-home.ts|src/renderer/home.ts]]
- [[src-renderer-layout.ts|src/renderer/layout.ts]]
- [[src-renderer-machinery.ts|src/renderer/machinery.ts]]
- [[src-renderer-project.ts|src/renderer/project.ts]]
