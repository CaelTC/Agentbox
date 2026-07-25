# 06 — Upload

**What to build:** From within a Project, the user picks files from their MacBook via a native file picker and they appear in the Project's Workspace for Claude to use. The copy is one-way (host→Box) and brokered by the trusted Launcher — Claude never gets direct access to the real laptop filesystem (see ADR 0001, threat A).

**Blocked by:** 05 — Project management home screen.

**Status:** done

- [ ] The Launcher offers an Upload action within a Project that opens a native macOS file picker.
- [ ] Selected files are copied into the current Project's Workspace.
- [ ] The copy is one-way: no live bind-mount, and Claude/the Box has no path back to the host filesystem.
- [ ] After uploading a file (e.g. a CSV), Claude can read it from within the Project.
