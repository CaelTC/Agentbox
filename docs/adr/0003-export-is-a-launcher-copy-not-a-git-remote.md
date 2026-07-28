# Export is a Launcher copy, not a git remote

## Status

accepted

## Context

Sandbox Users need the documents Claude produced inside the Box on their own MacBook. The request arrived as "host the Projects on GitHub, push from the Box, pull onto the computer" — but the Box and the computer are the *same laptop*, so GitHub would be a round trip to the public internet and back to the machine the files already live on.

The GitHub shape also costs more than it looks. Pushing from inside the Box requires a GitHub credential inside the Box, which contradicts Credential Hygiene and is exfiltratable by construction: Claude runs there with `--dangerously-skip-permissions` and unrestricted public egress (ADR 0001). Pushing from the host instead keeps the credential out of the Box, but still buys nothing for a same-machine transfer.

The stated reasons for wanting GitHub were off-laptop backup, version history, and sharing. None of those are transfer, and none are urgent enough to justify a credential or a second sync path today.

## Decision

Add **Export**: a one-way, user-initiated copy of selected Project files out of the Box onto the host, performed by the trusted Launcher via `docker cp`. No git, no GitHub, no credential anywhere. The Box is unchanged.

Four properties carry it:

1. **The Launcher owns both ends of the decision.** It builds the file list (via `docker exec`), renders the checkboxes, validates every path, and names the destination. Nothing served from inside the Box drives a host-side write, and no Box→Launcher channel is introduced.
2. **Only document-shaped files are offered** — documents plus web files, so a "personal webpage" Project is useful when it lands. Everything else is shown greyed with a reason rather than silently dropped.
3. **Bounded total size, refused above the cap.** The Resource Cap bounds the Box at ~25 GB; without a ceiling, Export would let a runaway Project pour that onto the user's real disk, which is threat A.
4. **The friendly Project name reaches the host through a display sanitizer and a containment check.** The name is read from `.agentbox/project.json` *inside* the Box, so Claude can write it — it is untrusted input on the path to a host filesystem write, and treated as such.

## Considered Options

- **Push to GitHub from inside the Box** — rejected: puts a pushable token in a container running an agent with permissions bypassed and open egress. Would require amending Credential Hygiene and ADR 0002.
- **Push to GitHub from the host Launcher** — rejected for now: credential-safe, but solves a transport problem that does not exist when source and destination are one machine. Still the right answer the day backup or sharing becomes a real requirement; Export's host folder is a working tree waiting for a `git init`.
- **A native macOS file picker, mirroring Upload** — not possible. A native dialog browses the host filesystem; the Workspace is a named volume inside a container and cannot be shown.
- **Mirror with pruning** — rejected: making the host folder an exact copy means the Launcher deletes files on the trusted machine, a new threat-A surface bought for tidiness.

## Consequences

- Export is the **first Box→host path in the system**. It does not weaken ADR 0001: it is a copy performed by trusted host code, not a bind mount, so `assertNoHostMounts` and the "no host mounts" invariant are untouched. A reader who finds the Launcher writing to `~/Agentbox` should read this ADR before assuming a bug.
- It introduces **threat C** (CONTEXT.md): content generated in the Box being executed on the host. The Box's walls cannot defend it, because it happens outside them. The realistic chain is prompt injection over the open egress the design deliberately allows — Claude fetches a page, the page tells it to write something poisoned, the user carries it across and opens it. The allowlist reduces this to the risk class of an email attachment; it does not eliminate it.
- Export never deletes on the host. Files removed inside the Box linger in the exported folder. Accepted: stale files are a smaller harm than the Launcher deleting a user's work.
- Backup, version history, and sharing remain **unsolved**. That is deliberate, not an oversight.

## Amendment — what lands carries the host's untrusted mark

Threat C's second layer was `chmod 0o644` on every exported file: nothing lands
executable, whatever the Box said. Porting the Launcher to Windows showed that
this layer is macOS-only — Windows' `chmod` toggles the read-only bit and decides
executability by extension, so on that host the defence quietly fell back to the
extension allowlist alone. An undocumented asymmetry in the one place these walls
admit they cannot defend is not something to ship.

Export now applies the host's own untrusted mark to each file as it lands, next
to the `chmod`, which stays: `Zone.Identifier` with `ZoneId=3` on Windows,
`com.apple.quarantine` on macOS. This is what makes "the risk class of an email
attachment", above, literally true rather than aspirational — Office opens marked
files in Protected View, SmartScreen and Gatekeeper get their say, browsers warn.

**The Sandbox User will see a Gatekeeper prompt on the Mac that they did not see
before.** That is the intended behaviour, not a regression: this ADR already says
the allowlist does not eliminate threat C and that opening what landed is the
user's call, and the prompt is the operating system asking exactly that question
at exactly the right moment. It is written here because it is a visible change to
a flow that worked, and a reader who finds a new dialog in front of a Sandbox
User deserves to find the reason for it.

A mark that fails to apply does **not** roll the export back — the files have
landed, and deleting a user's saved work to tidy up is the host-side deletion
this ADR refused above. The count of unmarked files is returned and shown
instead, because a mitigation that silently stopped applying is the failure this
amendment exists to prevent.
