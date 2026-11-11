---
tags: [module, core]
---

# `src/core/codex.ts`

Is there a newer Codex CLI to install? The pure half of the "Codex update available" banner — `main/codex.ts` runs the two commands whose output this reads, and nothing in here knows that a container exists.  Codex is npm-installed into the Box image (box/Dockerfile) and, unlike Claude Code, is deliberately NOT updated on every launch: `npm install -g` costs ~15s whether or not anything changed, and [[Refresh on Launch]] is meant to be free on a warm machine. So the launch only compares two version strings and the [[Sandbox User]] decides whether to spend the download.

Layer: [[core]]

- implements [[Harness]]
- tested by `launcher/test/codex.test.ts`
