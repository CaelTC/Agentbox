---
tags: [concept]
---

# GitHub Account

The [[Sandbox User]]'s own GitHub account, connected once through the [[Launcher]] by OAuth device flow — they type a code at github.com, never a token. The resulting token is held by the [[Launcher]] on the host, encrypted with the OS keystore, and is the only credential [[Agentbox]] has ever had. It never enters the Box. It carries `repo` scope, so it reads and writes every private repository that user owns: the containment in [[Save to GitHub]] is what stands between that and a container running the agent with its guardrails off (ADR 0006).
_Avoid_: "the Box's GitHub account", logging in inside the Box (the Box has no account and cannot get one)
