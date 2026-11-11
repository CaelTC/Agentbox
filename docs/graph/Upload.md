---
tags: [concept]
---

# Upload

A one-way, user-initiated copy of individual files from the [[Sandbox User]]'s computer into an existing [[Project]]'s [[Workspace]], performed by the trusted [[Launcher]] via a native file picker or files dropped onto the Files tab (a drop of a folder is refused — bringing a folder in is [[Project Import]]'s job, with its consent sheet). The agent never gets direct host filesystem access — it only sees the copies. Preserves threat A — true of picking a handful of files one at a time (a CSV, a script); not a claim this makes about carrying in a whole project, see [[Project Import]] for that.
_Avoid_: mount, shared folder (deliberately not a live bind-mount)
