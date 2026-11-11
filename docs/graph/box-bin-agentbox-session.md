---
tags: [box]
---

# `box/bin/agentbox-session`

**The funnel.** The single source of truth for launching a [[Project]]: validate the slug, require `.agentbox/project.json`, `tmux new-session -A`, then the [[Harness]] named in that metadata with its guardrails off ([[ADR 0001 — The container is the permission boundary]], [[ADR 0007 — A second agent, same walls]]).

- reached by [[src-main-session.ts|src/main/session.ts]] through [[Box-exec]]
- reached by [[box-terminal-server.py|box/terminal/server.py]] on a pty
- seeds a [[Seed Prompt]] on a fresh session only
