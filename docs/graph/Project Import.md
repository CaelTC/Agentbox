---
tags: [concept]
---

# Project Import

A one-way, user-initiated copy of a whole project folder from the [[Sandbox User]]'s computer into a new [[Project]]'s [[Workspace]], performed by the trusted [[Launcher]] via a `tar` stream piped into `docker cp`. `.gitignore` is the only filter — tracked and untracked-but-not-ignored files cross; a folder with no `.gitignore` copies wholesale, and the confirmation sheet says so. `.git` always crosses too, history included, accepted deliberately. Carries threat B in full: `.git` holds every secret ever committed and later removed, plus the remote URL and private history, and the [[Egress Policy]] cannot stop it leaving over the open public internet from a container running the agent with its guardrails off. The confirmation sheet is informed consent, not protection (ADR 0005).
_Avoid_: mirror of [[Export]], the reverse of [[Export]] ([[Export]] carries documents *out* under an allowlist; Import carries a whole project *in*, unfiltered — the two are not symmetric)
