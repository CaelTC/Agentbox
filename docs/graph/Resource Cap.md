---
tags: [concept]
---

# Resource Cap

The tuned, bounded [[Engine]] allocation baked into the [[Launcher]] (~4 CPU / 6 GB RAM / 25 GB disk cap). On macOS Colima enforces all three, and the disk cap bounds threat A — the Box can never grow past a known ceiling on the host. On Windows it is weaker and deliberately so: CPU and RAM come from a global `%USERPROFILE%\.wslconfig` shared with every other WSL distribution, and **there is no disk ceiling at all** — the VHDX grows on demand, so the cap is documented rather than enforced (ADR 0004).
