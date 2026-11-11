---
tags: [module, core]
---

# `src/core/delete.ts`

[[Delete Project]], and delete files INSIDE a [[Project]]. The mirror of `createProject`/`boxImportFolder`: a [[Project]] and everything in it — or a file and a folder within one — leaves the [[Workspace]] for good.  Deletion is PERMANENT and there is no trash. The [[Workspace]] is a named volume with no host mount (ADR 0001), so nothing here is on the user's real disk and nothing here is in a Finder trash they could fish it out of — the Box holds the only copy. A `.trash/` folder inside the Box would keep charging the [[Resource Cap]] for work the [[Sandbox User]] believes they threw away, which is the ceiling that bounds threat A; so the honest answer is to remove it and to be loud about that beforehand, which is what `confirmsProjectName` is for.  Already-Exported files are NOT touched. Those live on the [[Sandbox User]]'s own computer, put there deliberately by them (ADR 0003) — the [[Launcher]] does not reach back out and take them away.  The same contract holds one level down. Deleting a file inside a [[Project]] is permanent for exactly the same reasons, so it gets the same sentence on screen and the same absence of an undo — what differs is only how much friction the confirmation carries, which scales with what is going: a folder takes its contents with it and so earns the type-the-name gate, a ticked file does not.  The [[Launcher]] is the ONLY interface that can delete a file. [[The Box]]'s own web console stays read-only, deliberately: it runs without a password because every route in it is a read, and the first write route would spend that.  These are the pure decisions; the effects (killing the tmux session, the `rm -rf` inside the Box) live in main/workspace.ts.

Layer: [[core]]

- implements [[Delete Project]]
- imports [[src-core-export.ts|src/core/export.ts]]
- imports [[src-core-projects.ts|src/core/projects.ts]]
- tested by `launcher/test/delete.test.ts`
