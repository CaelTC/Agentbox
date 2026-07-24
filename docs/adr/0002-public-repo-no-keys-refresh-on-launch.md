# Public repo, no keys, refresh on launch

## Status

accepted

## Context

Claudebox is distributed by an Install Script (signed installers are not available to us) and must stay current on many non-technical colleagues' MacBooks. The obvious way to auto-update from a private GitHub repo is to package a GitHub key with the Launcher — but that puts a company credential on every laptop we don't control, which is exactly the shape of thing threat B exists to prevent. A key handed to non-technical users, packaged in a script, will eventually leak; and since the Box runs Claude with permissions bypassed and open public-internet egress, a key that reached inside the Box could be exfiltrated to `github.com`.

## Decision

Keep the Claudebox definition repo **public** and ship **no credentials anywhere** — not on the host, not in the Box. On every start the Launcher pulls the latest Box definition from the public repo and rebuilds the image only if it changed ("Refresh on Launch"). This is the sole update mechanism.

## Considered Options

- **Private repo + read-only single-repo deploy key in the Launcher** — rejected: a distributed credential that will leak, with blast radius on the private repo; contradicts the no-credentials stance.
- **Private repo + pre-built image on a registry pulled with a token** — rejected for the same credential-distribution reason.
- **A separate signed installer / update channel** — unavailable (we cannot sign apps).

## Consequences

- The Box definition (a Dockerfile and Claude Code container recipe) is publicly visible. This is acceptable — it contains no secrets.
- Threat B's credential half is closed by construction rather than by policy: there is simply no company secret to leak.
- Updates require a network pull at launch; an offline machine keeps running its last-built image.
