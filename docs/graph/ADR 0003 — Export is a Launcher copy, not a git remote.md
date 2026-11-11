---
tags: [adr]
---

# ADR 0003 — Export is a Launcher copy, not a git remote

Status: accepted

Sandbox Users need the documents Claude produced inside the Box on their own MacBook. The request arrived as "host the Projects on GitHub, push from the Box, pull onto the computer" — but the Box and the computer are the *same laptop*, so GitHub would be a round trip to the public internet and back to the machine the files already live on. The GitHub shape also costs more than it looks. Pushing from inside the Box requires a GitHub credential inside the Box, which contradicts [[Credential Hygiene]] and is exfiltratable by construction: Claude runs there with `--dangerously-skip-permissions` and unrestricted public egress (ADR 0001). Pushing from the host instead keeps the credential out of the B

Full text: `docs/adr/0003-export-is-a-launcher-copy-not-a-git-remote.md`
