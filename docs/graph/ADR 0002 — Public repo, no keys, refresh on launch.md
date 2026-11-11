---
tags: [adr]
---

# ADR 0002 — Public repo, no keys, refresh on launch

Status: accepted — amended by ADR 0006, which introduces the one credential Agentbox

[[Agentbox]] is distributed by an [[Install Script]] (signed installers are not available to us) and must stay current on many non-technical colleagues' MacBooks. The obvious way to auto-update from a private GitHub repo is to package a GitHub key with the [[Launcher]] — but that puts a company credential on every laptop we don't control, which is exactly the shape of thing threat B exists to prevent. A key handed to non-technical users, packaged in a script, will eventually leak; and since the Box runs Claude with permissions bypassed and open public-internet egress, a key that reached inside the Box could be exfiltrated to `github.com`.

Full text: `docs/adr/0002-public-repo-no-keys-refresh-on-launch.md`
