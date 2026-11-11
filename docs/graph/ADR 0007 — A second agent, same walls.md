---
tags: [adr]
---

# ADR 0007 — A second agent, same walls

Status: accepted

[[Agentbox]] was built around one coding agent. ADR 0001 turned Claude Code's per-action prompts off because the container is the wall, and the language in CONTEXT.md followed it: "Login with Claude" was *the* authentication method, and [[Credential Hygiene]] allowed only credentials that grant access to "Claude itself". Sandbox Users asked to try OpenAI's Codex CLI. It is the same shape of thing — an npm-installable terminal agent that takes a first prompt positionally and runs in a tmux session until told to stop — so the interesting question is not whether it fits in the Box, but whether it moves anything the Box's safety rests on. Three things looked like they might: Codex ships a sandbox of its

Full text: `docs/adr/0007-a-second-agent-same-walls.md`
