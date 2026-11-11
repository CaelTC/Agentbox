---
tags: [box]
---

# `box/entrypoint.sh`

Boot order inside [[The Box]]: [[Egress Policy]] first, then the ChatGPT-login bridge ([[Agent Login]]), then the console, then sleep. Also writes the Box-global `AGENTS.md` every agent reads.

- runs [[box-egress-apply-egress.sh|box/egress/apply-egress.sh]]
- starts [[box-terminal-server.py|box/terminal/server.py]]
