---
tags: [adr]
---

# ADR 0005 — Import is a whole project, not a filtered copy

Status: accepted

Sandbox Users sometimes already have a project on their own computer — a folder of code with a `.git` history — and want to keep working on it inside the Box rather than starting from a blank [[Project]]. [[Export]] (ADR 0003) moves the opposite direction, and under an allowlist: it copies [[Project]] documents out of the Box, deliberately partial, because an unbounded copy onto the host is threat A. None of that reasoning transfers here. A repo the [[Sandbox User]] chose to bring in is the thing they came here to work on, and refusing files because they aren't "document-shaped" would refuse the project itself. There is also no size cap to refuse above, the way [[Export]] has one: Import writes into the Box's o

Full text: `docs/adr/0005-import-is-a-whole-project-not-a-filtered-copy.md`
