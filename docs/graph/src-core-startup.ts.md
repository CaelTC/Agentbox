---
tags: [module, core]
---

# `src/core/startup.ts`

Startup orchestration (ticket 04). Given what's already running, decide the minimal ordered set of steps to get the [[Sandbox User]] into a working session. Pure so the "fast reopen returns to a working session" behaviour is testable without a live [[Engine]].

Layer: [[core]]

- implements [[Engine]]
- tested by `launcher/test/startup.test.ts`
