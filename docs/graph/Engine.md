---
tags: [concept]
---

# Engine

The headless, license-free container runtime that runs the Box on the host in place of Docker Desktop — Colima on macOS, a Podman machine (WSL2, rootful) on Windows. Two runtimes, one property: neither is headed and neither carries a commercial licence (ADR 0004). The [[Launcher]] holds an Engine, not a runtime — `isRunning()` and `start()` are all it ever asks, and each runtime's quirks live in its own adapter, so every step outside those two adapters is the same on both platforms.
