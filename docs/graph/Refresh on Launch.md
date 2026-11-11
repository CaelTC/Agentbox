---
tags: [concept]
---

# Refresh on Launch

On every start, the [[Launcher]] pulls the latest Box definition from the public [[Agentbox]] GitHub repo and rebuilds the image if it changed, then runs `claude update` inside the running Box (the image's npm layer is cached, so a rebuild alone would keep shipping a stale Claude). This is the sole update mechanism for the Box and for Claude Code, and the same one runs on demand from **Update [[Agentbox]]** on the home screen — for the [[Sandbox User]] who never quits the [[Launcher]] and would otherwise sit on last week's Box until they did. On demand it also recreates the container, because a rebuilt image changes nothing while the old one is still running; that ends every open agent session, so it is confirmed first. Requires no credentials because the repo is public. Both halves are best-effort: an offline laptop still opens on its last-built image and its baked Claude, and is told so rather than shown a silent "up to date". Codex sits deliberately outside this: `npm install -g` costs ~15s whether or not anything changed, so a newer Codex is offered as a notice on the home screen and spent only when the [[Sandbox User]] presses it, and a recreate drops it back to the version baked into the image (ADR 0007).
