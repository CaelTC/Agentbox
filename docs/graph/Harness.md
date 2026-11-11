---
tags: [concept]
---

# Harness

Which coding agent a session runs — Claude Code or OpenAI Codex. One app-level setting the [[Sandbox User]] picks in the [[Launcher]] (`~/.agentbox/settings.json`, default Claude), stamped into a [[Project]]'s metadata as it opens, because `agentbox-session` takes the agent from there. What a [[Project]]'s tile then reports is the agent it was last opened with — history, not a promise: the picker decides the next open. Both run with their own guardrails off, because the Box is the boundary for either of them (ADR 0001, ADR 0007).
_Avoid_: model, per-project agent (it is one choice for the whole app, and the metadata is only how it is delivered)
