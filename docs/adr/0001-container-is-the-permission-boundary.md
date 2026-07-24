# The container is the permission boundary

## Status

accepted

## Context

Claudebox lets non-technical colleagues run Claude Code on their MacBooks to practice and play. It must defend two harms: (A) Claude cannot damage the laptop, and (B) Claude cannot reach company systems. Claude Code's own defence is a per-action approval prompt ("Allow this command?"), but that defence is worthless for this audience — a non-coder cannot evaluate the prompt and will either freeze or reflexively approve everything.

## Decision

Make the container the security boundary and turn Claude Code's prompts off inside it. Concretely, four decisions that only make sense as one:

1. **Run in a container** ("the Box"), headless via **Colima** rather than native Claude Code or a heavy VM.
2. **No host filesystem mounts.** The Box cannot see a single real file on the laptop; the user's work lives on a named Docker volume (the Workspace). Defends A.
3. **Egress = open public internet, all private/local ranges blocked** (RFC-1918, link-local, host gateway). The Box physically cannot reach the company LAN or the laptop's local network. Combined with holding no company credentials, this defends B.
4. **Claude Code runs with permissions bypassed** inside the Box. Because 1–3 leave nothing dangerous for Claude to reach, the prompts guard against nothing, so removing them gives non-coders a frictionless experience.

## Considered Options

- **Native Claude Code with its own prompts** — rejected: one wrong "yes" reaches the real filesystem and full network; prompts are meaningless to non-coders.
- **A full VM** — rejected: strongest isolation but too slow, heavy, and opaque for the ease-of-use goal.
- **Container with prompts left on** — rejected: redundant friction that this audience can't act on meaningfully, given the walls are already real.

## Consequences

- The safety of the whole system rests on the container walls being correct — the egress rules and the absence of host mounts are load-bearing, not conveniences.
- Claude can freely clobber the user's own in-Box Workspace. This is acceptable: it's a throwaway playground, recoverable, and neither an A nor a B concern.
- Threat D (a user uploads a company file, which Claude then sends to a public service over open egress) is *not* closed by this boundary. It is explicitly out of scope for now.
