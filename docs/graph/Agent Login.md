---
tags: [concept]
---

# Agent Login

The authentication method — the [[Sandbox User]] signs into their own subscription seat via OAuth from inside the Box, in the [[Harness]]'s own words: **Login with Claude** for Claude Code, **Sign in with ChatGPT** for Codex. The only credentials the Box ever holds; each grants its own coding agent and nothing else. Codex's callback server binds the Box's own loopback, so the [[Launcher]] publishes `127.0.0.1:1455` and a bridge inside the Box forwards to it — the host reaching in, like [[Web Preview]], not a new way out (ADR 0007).
_Avoid_: API key (deliberately not used)
