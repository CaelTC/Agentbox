---
tags: [adr]
---

# ADR 0006 — The GitHub token lives on the host, never in the Box

Status: accepted

Sandbox Users can carry work out of the Box onto their own computer ([[Export]], ADR 0003) and bring a folder in ([[Project Import]], ADR 0005), but they have no way to put a [[Project]] somewhere durable. "[[Save to GitHub]]" publishes a [[Project]] to the [[Sandbox User]]'s own GitHub account. That needs a credential, and ADR 0002 closed threat B's credential half "by construction" — no keys anywhere, host or Box. This ADR amends that: a credential now exists, on the **host**, held by the [[Launcher]]. It never enters the Box. The obvious implementation does not work. Handing the Box a token as `docker run -e` makes it readable by everything in the container; Claude runs there with permissions bypassed, and egress to

Full text: `docs/adr/0006-the-github-token-lives-on-the-host.md`
