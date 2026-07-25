# Import is a whole project, not a filtered copy

## Status

accepted

## Context

Sandbox Users sometimes already have a project on their own computer — a
folder of code with a `.git` history — and want to keep working on it inside
the Box rather than starting from a blank Project. Export (ADR 0003) moves the
opposite direction, and under an allowlist: it copies Project documents out of
the Box, deliberately partial, because an unbounded copy onto the host is
threat A. None of that reasoning transfers here. A repo the Sandbox User chose
to bring in is the thing they came here to work on, and refusing files because
they aren't "document-shaped" would refuse the project itself. There is also
no size cap to refuse above, the way Export has one: Import writes into the
Box's own bounded Workspace volume (the Resource Cap, CONTEXT.md), not onto the
user's real disk, so "too large" is simply refused for not fitting, not for
being merely big.

## Decision

A folder on the Sandbox User's computer *becomes* a Project. Concretely:

1. **Whole-project entry, contents at the Project root.** The folder's
   contents land directly at the new Project's root, never nested one level
   down, because `box/bin/claudebox-session` launches Claude with its cwd set
   to exactly that root. A nested folder would put the real work below cwd,
   and the project's own `CLAUDE.md` / `.claude/` would sit one level too deep
   for Claude Code to load them automatically.
2. **`.gitignore` is the only filter.** The path list is
   `git ls-files --cached --others --exclude-standard -z` — tracked files plus
   untracked-but-not-ignored, so uncommitted work still crosses. Only what the
   user's own ignore rules exclude stays behind. A folder with no `.gitignore`
   is not specially filtered at all: everything copies wholesale, and the
   confirmation sheet says so rather than staying quiet about it.
3. **`.git` always crosses, history included.** `git ls-files` never lists
   `.git` itself, so it rides along as an explicit extra path alongside
   whatever the listing produced. Accepted deliberately, not an oversight —
   see the limit below.

## Considered Options

- **Mirror Export: an allowlist of importable file kinds** — rejected.
  Export's allowlist exists because an unbounded copy onto the host is
  threat A; Import writes into the Box's own bounded Workspace, so that reason
  doesn't apply, and refusing a `.py` file or a `.git` directory for not being
  document-shaped would refuse the project itself.
- **Nest the folder one level inside the new Project**
  (`<Project>/<folder-name>/…`) — rejected: `claudebox-session` always starts
  Claude at the Project root, so anything nested below it stops being the
  thing Claude opens into, and its `CLAUDE.md`/`.claude/` go unread.
- **Drop `.git`, keep only the working tree** — rejected: this is presented to
  the Sandbox User as bringing in *their project*, and a project stripped of
  its history is a materially different, lesser thing. See Consequences for
  what carrying it forward costs.

## Consequences

- **The honest limit.** Threat B (CONTEXT.md) is any path from the sandbox to
  company systems, credentials, or private repos. `.gitignore` only ever
  protected the working tree — it says nothing about what is inside `.git`. A
  `.git` directory carries every secret ever committed and later "removed"
  (the objects are still in the pack files), the remote URL, and full private
  history. The Egress Policy cannot help: it blocks private/local ranges, but
  exfiltration from here would leave over the *public* internet the design
  deliberately keeps open, from a container running Claude with
  `--dangerously-skip-permissions`. Once a private repo is in the Box,
  Claudebox has no control that gets it back out of reach. The container
  boundary (ADR 0001) protects the host *from* the Box; it does nothing for
  data carried *in*. The confirmation sheet Import shows before copying is
  informed consent, not a protection.
- Submodules arrive as empty directories: `git ls-files` does not recurse into
  a submodule without `--recurse-submodules`, and Import does not pass it.
- A symlink pointing outside the imported folder copies as a dangling
  symlink — harmless, because the Box cannot reach the host filesystem it
  would have pointed at (ADR 0001).
- The seed prompt is stored in the Project's own metadata and re-read every
  time `claudebox-session` starts a fresh tmux session for that slug,
  including after a Box restart — so a Sandbox User who restarts the Box
  before their first message sees the Import seed prompt again, not silence.
- Getting a real folder into the Box needed its own fixes, live-discovered
  against a running Box rather than guessed at: `tar` must suppress macOS
  xattrs (`com.apple.provenance` makes `docker cp` abort on overlayfs) and the
  AppleDouble `._name` sidecars bsdtar otherwise writes beside every entry, and
  the copied tree is `chown`-ed to the sandbox user afterward, because
  `docker cp` synthesises the parent directories `git ls-files` never listed
  (`src/`, …) as root. These fixes are macOS-specific — `tar`'s argv is not yet
  branched on host platform the way the `docker`/Engine invocation now is
  (ADR 0004), so a Windows Import is unproven; the code says so and leaves it
  for a later issue.
