---
tags: [adr]
---

# ADR 0001 — The container is the permission boundary

Status: accepted — extended by ADR 0007, which puts a second agent (OpenAI Codex) inside

[[Agentbox]] lets non-technical colleagues run Claude Code on their MacBooks to practice and play. It must defend two harms: (A) Claude cannot damage the laptop, and (B) Claude cannot reach company systems. Claude Code's own defence is a per-action approval prompt ("Allow this command?"), but that defence is worthless for this audience — a non-coder cannot evaluate the prompt and will either freeze or reflexively approve everything.

Full text: `docs/adr/0001-container-is-the-permission-boundary.md`
