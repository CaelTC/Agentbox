---
tags: [module, core]
---

# `src/core/config.ts`

Load-bearing constants for [[Agentbox]]. These encode the decisions from ADR 0001 (the container is the permission boundary) and the ticket acceptance criteria. They are pure data so they can be asserted in tests.  This file is the declared source of truth, but three scripts that run without the [[Launcher]] must carry their own copies (`install/install.sh`, `install/install.ps1`, `scripts/agentbox.sh`). `test/config.test.ts` reads those scripts and fails on any value that drifts from what is declared here.

Layer: [[core]]

- implements [[Harness]]
- tested by `launcher/test/config.test.ts`
