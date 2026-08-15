# A second agent, same walls

## Status

accepted

## Context

Agentbox was built around one coding agent. ADR 0001 turned Claude Code's
per-action prompts off because the container is the wall, and the language in
CONTEXT.md followed it: "Login with Claude" was *the* authentication method, and
Credential Hygiene allowed only credentials that grant access to "Claude
itself".

Sandbox Users asked to try OpenAI's Codex CLI. It is the same shape of thing —
an npm-installable terminal agent that takes a first prompt positionally and
runs in a tmux session until told to stop — so the interesting question is not
whether it fits in the Box, but whether it moves anything the Box's safety rests
on. Three things looked like they might: Codex ships a sandbox of its own
(Landlock/seccomp on Linux) on top of its approval prompts, it authenticates
against a second vendor, and it talks to a second set of endpoints.

## Decision

Add Codex as a second **Harness**, and change nothing about the boundary. The
funnel (`box/bin/agentbox-session`) grows a table of two agents, selected by the
optional `agent` key in a Project's `.agentbox/project.json`; no key means
Claude Code, so every Project that already exists is untouched.

1. **The container is still the wall.** Codex runs
   `--dangerously-bypass-approvals-and-sandbox` for exactly ADR 0001's reasons —
   a non-coder cannot evaluate an approval prompt — plus one that is Codex's
   own: whether its Landlock sandbox engages at all is decided by the host
   kernel and the engine's seccomp profile, not by the image, and that differs
   between Colima's VM and a rootful Podman machine on WSL2 (ADR 0004). A
   defence that may or may not be there is one you cannot state, and this one
   would be guarding a filesystem with no host mounts and a network with the
   private ranges already blocked. Both agents therefore run with their own
   guardrails off, and the walls carry the same load they always did.
2. **A second vendor credential class, in the class Credential Hygiene already
   allows.** "Sign in with ChatGPT" is OAuth against the Sandbox User's own
   ChatGPT seat; the token persists in `~/.codex/auth.json` on the
   `agentbox-home` volume, beside Claude's. Credential Hygiene widens from
   "credentials that grant access to Claude itself" to "the coding agent
   itself": the rule was never about Anthropic, it was about a credential that
   unlocks the agent seat and nothing else. Still no API keys, still no company
   credential, still nothing the Launcher holds (ADR 0006 is the one exception
   and it stays on the host).
3. **OpenAI's endpoints are a second egress destination, and the Egress Policy
   needs no change.** It blocks private/local ranges and leaves the public
   internet open; `api.openai.com` sits in the open half exactly as
   `api.anthropic.com` does. Threat B is unmoved. Threat D — a Sandbox User
   uploads a company file and the agent sends it to a public service — gains a
   second place it could go, which is a second instance of a risk ADR 0001
   already declared out of scope, not a new one.
4. **The OAuth callback is bridged inward, not outward.** Codex hard-binds its
   callback server to `127.0.0.1:1455` *inside* the Box, where Docker's
   published port cannot reach it — the engine forwards to the Box's bridge
   (eth0) address, never container loopback. So the Launcher publishes
   `127.0.0.1:1455` on the host like every other forward, and `entrypoint.sh`
   runs a `socat` from the bridge address to container loopback. Bound to that
   address specifically and never `0.0.0.0`: a wildcard bind would collide with
   Codex's own listener and, while Codex is not up, would accept its own
   forwards in a loop. This is the host reaching into the Box, like Web Preview,
   and it weakens neither threat A nor B.
5. **Harness is an app-level choice, not a per-Project one.** It lives in
   `~/.agentbox/settings.json` (default `claude`) and is stamped into the
   Project's metadata in the same gated turn as the open, immediately before it,
   so what starts is what the setting says at that moment.
6. **One memory document, two agents.** `entrypoint.sh` writes the Preview and
   Database contracts to `~/.codex/AGENTS.md` on every start and points
   `~/.claude/CLAUDE.md` at it with a symlink, so the two harnesses cannot be
   told different things.

## Considered Options

- **An OpenAI API key in the Box** — rejected: a bearer credential for a billed
  account, in a container running an agent with its guardrails off and open
  public egress, is the exfiltration chain ADR 0002 and ADR 0003 both refuse.
  The subscription OAuth token grants the seat the Sandbox User already has,
  which is the whole of what Credential Hygiene permits.
- **Leave Codex's own sandbox on** — rejected: unreliable inside the container
  for the reason above, and redundant with walls that already hold. It would
  also bring back the approval prompts this audience cannot act on, which is the
  friction ADR 0001 spent the container to remove.
- **Make the agent a per-Project choice** — rejected: `.agentbox/project.json`
  is how the choice is *delivered* to the funnel, not where it is made. The Box
  can write that file, so a per-Project setting would be a user preference the
  agent could rewrite (the same reasoning that keeps the GitHub repo name on the
  slug in ADR 0006), and "which agent is this Project?" is a question a Sandbox
  User has no basis to answer twice.
- **Update Codex on every launch, the way Claude Code is updated** — rejected:
  `claude update` is a ~1s no-op when nothing is new, while
  `npm install -g @openai/codex` costs ~15s whether or not anything changed.
  Refresh on Launch is meant to be free on a warm machine, so a Codex update is
  offered as a notice on the home screen and spent only when pressed.

## Consequences

- **The boundary is unchanged, and that is the finding rather than a
  formality.** A second agent was added without touching the egress rules, the
  mount policy, or ADR 0001. If a third one ever needs them changed, that is the
  signal to re-open this.
- The home volume now holds two vendor tokens. Deleting it signs the Sandbox
  User out of both, and a Sandbox User who switches Harness mid-project is
  asked to log in to the other vendor once.
- **Codex goes stale between presses.** It is not refreshed on launch, so a Box
  that has sat for a month runs a month-old Codex until someone uses the notice;
  and recreating the container drops it back to the version baked into the
  image, so the notice reappears. Accepted deliberately — the alternative was a
  ~15s tax on every start.
- **A live session keeps the agent it started with.** The stamp lands before the
  open, but the funnel attaches to an existing tmux session rather than
  replacing it, so changing the setting under a Project whose session is already
  running does nothing until that session ends.
- **The Batteries are now carried twice.** Codex cannot install a Claude Code
  plugin, so the mattpocock-skills battery is ported into `box/codex-skills/`
  as the `SKILL.md` directories Codex reads and laid into the home volume on
  every start. The same disciplines by two mechanisms — and two copies to keep
  in step, the way the Preview contract's two copies already are.
- Two agents mean two vendors' guardrails are off inside the Box, so the
  correctness of the walls is now load-bearing for both — the same rest as
  before, carried twice.
