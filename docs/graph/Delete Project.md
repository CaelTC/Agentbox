---
tags: [concept]
---

# Delete Project

A one-way, user-initiated removal of a [[Project]] and everything in it from the [[Workspace]], performed by the trusted [[Launcher]]. Permanent: there is no trash. The [[Workspace]] is a named volume with no host mount, so a deleted [[Project]] is not in the [[Sandbox User]]'s own trash either — the Box held the only copy. A trash folder inside the Box was rejected deliberately, because it would go on charging the [[Resource Cap]] for work the [[Sandbox User]] believes they threw away, and the [[Resource Cap]] is what bounds threat A. What survives is whatever they had already Exported, which lives on their computer and is theirs; the [[Launcher]] does not reach back out and take it. The [[Project]]'s tmux session is killed before its folder is removed — a session outlives its directory, and the funnel would otherwise re-attach the next [[Project]] with the same slug to the dead one. Confirmation is typing the [[Project]]'s name, so this is never a slipped click.
_Avoid_: archive, close, remove from list (nothing is kept and nothing is merely hidden — the files are gone), the mirror of Import (Import brings a copy in and leaves the original alone; Delete destroys the only copy)
