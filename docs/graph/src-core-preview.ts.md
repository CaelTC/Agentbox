---
tags: [module, core]
---

# `src/core/preview.ts`

[[Web Preview]] (ticket 07): the laptop reaching INTO the Box to view a page the [[Sandbox User]] had Claude build. This is safe under both threats (ADR 0001) — it grants the Mac's browser inbound access to a Box port and nothing more.  Mechanism: the Box publishes a small set of common dev-server ports, each bound to 127.0.0.1 so ONLY the Mac's localhost (its browser) can reach them — never the LAN, and never in the Box→host direction. "Preview" then detects which port is actually serving and opens it.

Layer: [[core]]

- implements [[Web Preview]]
- imports [[src-core-config.ts|src/core/config.ts]]
- tested by `launcher/test/preview.test.ts`
