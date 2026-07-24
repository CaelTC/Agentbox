# 09 — Distribution: install script + refresh on launch

**What to build:** Two halves of getting and keeping Claudebox on a machine (see ADR 0002). First-time setup: a one-time Install Script (no signed app) installs Colima and the Launcher and prepares the initial Box image. Ongoing: on every start the Launcher pulls the latest Box definition from the public GitHub repo and rebuilds the image only if it changed — the sole update mechanism, requiring no credentials because the repo is public.

**Blocked by:** 04 — Launcher skeleton.

**Status:** ready-for-agent

- [ ] Running the Install Script on a clean Mac installs Colima and the Launcher (in Applications) and prepares the initial image.
- [ ] On each start, the Launcher pulls the latest Box definition from the public repo.
- [ ] If the definition changed, the Launcher rebuilds the image; if unchanged, it starts quickly without rebuilding.
- [ ] No GitHub credential or key is present on the host or in the Box at any point.
