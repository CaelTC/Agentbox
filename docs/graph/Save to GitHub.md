---
tags: [concept]
---

# Save to GitHub

A one-way, user-initiated publish of a [[Project]] to the connected [[GitHub Account]] — back to the [[Project]]'s own `origin` if it came in with one and the token may push there, otherwise into a newly created private repo named after the slug — performed by the trusted [[Launcher]] as two ephemeral containers: one mounts the [[Workspace]] and writes a git bundle but holds no token, the other holds the token and never mounts the [[Workspace]]. The agent controls the [[Project]]'s `.git`, and a `pre-push` hook or a `credential.helper` line in `.git/config` would read any credential present — so the split is the whole defence, enforced in code, not a convention (ADR 0006). Ordinary git otherwise: it commits in the [[Project]]'s own repository and pushes the branch that is checked out to the same name on GitHub — on `main` you get `main`, on `feature/x` you get `feature/x` — so saving stages whatever is in flight and advances that branch. Never publishes a `.env`, key file, or `node_modules`, whatever the [[Project]]'s own `.gitignore` says. Pushes, never force-pushes.
_Avoid_: sync, backup (it is neither continuous nor automatic), "git integration" ([[Agentbox]] configures no remote inside the Box — it only reads the one an Import brought — the Box never holds the token, and there is no clone-in)
