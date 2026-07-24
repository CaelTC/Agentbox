# 04 — Launcher skeleton: double-click → chat

**What to build:** A non-technical colleague double-clicks the Launcher icon and, with no terminal and no visible Docker, ends up talking to Claude Code inside the Box. The Launcher owns starting Colima (with the Resource Cap) and the Box, and attaching the user to a session. This replaces the shell script for day-to-day use.

**Blocked by:** 01 — Walking skeleton. (Best sequenced after #02 and #03 so it launches the hardened, batteried Box.)

**Status:** ready-for-agent

- [ ] A double-clickable macOS Launcher app exists (no signing required to run locally).
- [ ] Launching it starts Colima with the Resource Cap and the Box if not already running.
- [ ] The user is attached to a working Claude Code session without seeing a terminal or Docker/Colima internals.
- [ ] Closing and reopening the Launcher returns to a working session with the Workspace intact.
