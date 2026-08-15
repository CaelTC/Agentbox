# The Codex skills battery

The Codex-side equivalent of the mattpocock-skills plugin the Dockerfile
installs for Claude Code. Same battery of engineering disciplines — TDD,
diagnosing bugs, code review, grilling, domain modelling — in the form Codex
reads.

## Why a copy and not the plugin

Codex cannot install a Claude Code plugin, and there is no marketplace to point
it at. What it *does* have is skills: a directory per skill, each holding a
`SKILL.md` with `name` and `description` YAML frontmatter, invoked by typing
`$<name>` or selected implicitly by the model. Codex reads them (verified
against the codex 0.147.0 source, `codex-rs/ext/skills/src/host_roots.rs`)
from, in order: `$CWD/.agents/skills` and its ancestors up to the repo root,
`$CODEX_HOME/skills` (deprecated), **`$HOME/.agents/skills`** (user scope — the
one we use), and `/etc/codex/skills`.

Note for anyone porting an older recipe: `~/.codex/prompts` — the markdown
custom-prompt directory Codex used to read — no longer exists in 0.147.0.
Skills replaced it.

So the skills are ported, not installed: the text is the upstream text with
Claude-only mechanics adapted, since a skill that tells the agent to "spawn
parallel sub-agents with the Agent tool" is a skill that misfires in Codex.

## How they get into the Box

`box/Dockerfile` copies this directory to `/opt/codex-skills` in the image, and
`box/entrypoint.sh` lays it into `/home/sandbox/.agents/skills` on every start.
The copy at start (rather than baking straight into the home directory) is the
same reason `~/.claude/CLAUDE.md` is rewritten every start: `/home/sandbox` is
a named volume, so anything baked there freezes at whatever the image held when
the volume was first created. Files that aren't ours are left alone.

## Provenance

Ported from [mattpocock/skills](https://github.com/mattpocock/skills) (MIT,
© Matt Pocock) — the same source as the Claude-side plugin, so the two agents
give the Sandbox User the same disciplines.

## What was ported, and what wasn't

Ported: `tdd`, `diagnosing-bugs`, `code-review`, `research`, `prototype`,
`resolving-merge-conflicts`, `grilling`, `handoff`, `implement`,
`codebase-design`, `domain-modeling`, `improve-codebase-architecture`.

Adapted where the upstream leaned on Claude-only mechanics:

- **code-review** ran its two axes as parallel sub-agents; here they are two
  sequential passes, each written out in full before the next begins, which
  keeps the axes separate but not context-isolated.
- **research** delegated to a background agent; here the session does the
  reading itself. The discipline that mattered — primary sources, cited
  findings in one Markdown file — is unchanged.
- **codebase-design**'s design-it-twice spawned one sub-agent per candidate
  interface; here the designs are written one after another under different
  constraints. Genuinely weaker: one context can't un-see its first idea, so
  the instruction to make each design *radically* different carries more load.
- **improve-codebase-architecture** explored via a sub-agent and rendered a
  Tailwind/Mermaid HTML report; here the session explores directly and writes a
  Markdown report, because a Box has no browser to open a temp-dir HTML file in.

Skipped:

- **setup-matt-pocock-skills** — installs the Claude plugin's conventions.
- **ask-matt** — a router over the plugin's `/`-commands, most of which aren't
  here; it would describe a map that doesn't match the territory.
- **wayfinder**, **triage**, **to-spec**, **to-tickets** — all assume the issue
  tracker workflow that `setup-matt-pocock-skills` writes to
  `docs/agents/issue-tracker.md`, and wayfinder additionally assumes research
  sub-agents.
- **grill-me** and **grill-with-docs** — one-line aliases for `grilling` that
  exist because Claude distinguishes slash commands from model-invoked skills.
  Codex invokes any skill with `$grilling`, so the folded-in note about using
  `$domain-modeling` alongside it covers both.
- **teach**, **writing-great-skills** — a multi-session learning workspace and a
  guide to authoring Claude skills; neither is a coding discipline.

## Adding one

Make a directory, put a `SKILL.md` in it with `name:` (matching the directory
name) and a single-line `description:` in the frontmatter, and reference
sibling skills as `$name`. `launcher/test/batteries.test.ts` checks the shape.
