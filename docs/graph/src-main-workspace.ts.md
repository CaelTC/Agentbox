---
tags: [module, main]
---

# `src/main/workspace.ts`

Box-side [[Workspace]] operations. Because the [[Workspace]] is a NAMED VOLUME and not a host mount (ADR 0001, threat A), the [[Launcher]] cannot write [[Project]] folders on the host — it brokers them into the Box through the [[Box-exec]] seam (`./box-exec`), which owns every `docker exec` / `docker cp` here: its argv, its shell quoting, and the rule that a non-zero exit is an error.  The DECISIONS (safe slug, collision-free destinations) come from the pure, tested core helpers; only the EFFECTS live here.  Every entry point takes the Box as its last argument, defaulted to the real one, so these operations are assertable against a fake Box — the same injection style as `spawnPath(path, exists)` and `markExportedUntrusted`. `run` survives only for HOST commands (`git`, `xattr`), never for the Box.

Layer: [[main]]

- implements [[Workspace]]
- imports [[src-main-workspace-projects.ts|src/main/workspace-projects.ts]]
- imports [[src-main-workspace-export.ts|src/main/workspace-export.ts]]
- imports [[src-main-workspace-delete.ts|src/main/workspace-delete.ts]]
- imports [[src-main-workspace-upload.ts|src/main/workspace-upload.ts]]
- imports [[src-main-workspace-import.ts|src/main/workspace-import.ts]]
- tested by `launcher/test/workspace.test.ts`
