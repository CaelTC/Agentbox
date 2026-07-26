# The GitHub token lives on the host, never in the Box

## Status

accepted

## Context

Sandbox Users can carry work out of the Box onto their own computer (Export,
ADR 0003) and bring a folder in (Project Import, ADR 0005), but they have no way
to put a Project somewhere durable. "Save to GitHub" publishes a Project to the
Sandbox User's own GitHub account.

That needs a credential, and ADR 0002 closed threat B's credential half "by
construction" — no keys anywhere, host or Box. This ADR amends that: a credential
now exists, on the **host**, held by the Launcher. It never enters the Box.

The obvious implementation does not work. Handing the Box a token as
`docker run -e` makes it readable by everything in the container; Claude runs
there with permissions bypassed, and egress to `github.com` is open by design, so
`printenv` plus one `curl` is the whole exfiltration chain. The same is true of a
mounted token file, an in-Box `gh auth login`, and a credential-helper socket.
There is no "use but not see" for a bearer token.

Two choices made by the Sandbox User's own decision, which set the blast radius:

- The token is for **their real GitHub account**, not a dedicated sandbox
  account.
- It carries **`repo` scope** — the narrower `public_repo` cannot create the
  private repository this feature publishes into, and a GitHub App's installation
  token cannot create a repository under a personal account at all.

So the token **reads and writes every private repository that user owns**. That
is the cost of the feature, stated plainly, and it is why the containment below
is the feature rather than a nicety.

## Decision

**The credential and the Workspace volume never appear in the same container.**

The naive single-container version — mount the Workspace, hold the token, run
`git push` — is broken, because Claude controls `/workspace/<slug>/.git`:

- `.git/hooks/pre-push` executes in that container, with the token in its
  environment (or readable from the parent's `/proc/<pid>/cmdline` if it were
  passed in the URL);
- `.git/config` can set `credential.helper` — which git *hands the credential to*
  on success — as well as `core.fsmonitor` and `uploadpack.packObjectsHook`, both
  of which run commands.

Git has no "ignore repo-local config" switch, so no combination of `-c` flags
closes this. The separation has to be structural. Publishing is two ephemeral
containers off `claudebox:latest`, bridged by a scratch named volume
(`claudebox-git`) that the long-lived Box never mounts:

1. **Container A — has the Workspace, has no token.** Commits the Project in its
   own repository (`git init -b main` if it has none), reads back the branch that
   is checked out, and bundles it. Ordinary git: a Project on `main` publishes
   `main`, a Project on `feature/x` publishes `feature/x`. Hostile content here
   gains exactly the privilege Claude already has, which is why the commit — the
   step that must touch Claude's filesystem — happens on this side of the wall.
   A detached HEAD has no branch to push and is reported as a sentence.
2. **Container B — has the token, never mounts the Workspace.** Fetches the
   bundle into a bare repo it created itself, so the only git config consulted is
   the one it just wrote, and pushes. A bundle is a packfile plus a ref list:
   fetching one imports no config and executes nothing. The refspec is explicit
   on both ends, so a crafted ref name inside the bundle cannot cross into the
   push.

`assertNoWorkspaceMount` (`core/github.ts`) makes this a checked precondition
rather than a convention, mirroring `assertNoHostMounts` in `core/box.ts`: the
credentialed run refuses to start if its `-v` flags name the Workspace volume.

Supporting decisions:

- **OAuth device flow**, so a non-coder never handles a PAT. The client id ships
  in `core/config.ts` and is not a credential — the device flow sends no client
  secret — which keeps ADR 0002's "no keys in the repo" intact.
- **The token reaches the engine CLI through the spawn's environment**, and is
  passed to the container as `-e NAME` with no value, so it appears in no
  process's argv on either side.
- **At rest it is encrypted with the OS keystore** (`safeStorage`: Keychain on
  macOS, DPAPI on Windows) in `~/.claudebox/github.json`. If no keystore is
  available the Launcher refuses to store it at all rather than writing a `repo`
  token in the clear.
- **Push, never force.** A rejection is reported as "GitHub has changes Claudebox
  doesn't"; discarding remote history is not Claudebox's call.
- **The branch name is untrusted input.** It is chosen inside the Box and ends up
  embedded in the one script that runs with the credential, so it is validated
  against `^[A-Za-z0-9][A-Za-z0-9._/-]*$` (no `..`, no `.lock`) before it crosses
  — narrower than git itself accepts, and narrow enough that nothing in it can end
  a shell word. It is read back from a *marked* stdout line, because the Box
  image's entrypoint writes to stdout too.

## Considered Options

- **Token as an env var / mounted file in the Box** — rejected: `printenv` and
  open egress. This is the option the feature request started from.
- **One container holding both the Workspace and the token** — rejected: the
  `.git` hook and config vectors above. This is the subtle one, and the reason
  the design has two containers instead of one.
- **A dedicated sandbox GitHub account** — recommended and declined by the
  Sandbox User. It would have made the containment belt-and-braces; as built, the
  containment is the only thing standing between a `.git/hooks/pre-push` and
  every private repo they own.
- **`public_repo` scope** — recommended and declined: it cannot create or push to
  a private repo, and publishing was to be private.
- **A GitHub App instead of an OAuth App** — rejected on capability, not
  preference: `POST /user/repos` documents classic scopes only, so an App cannot
  create the repository under a personal account.

## Consequences

- **The honest limit.** A token with `repo` scope exists on the laptop. The Box
  cannot read it, but anything that compromises the *host* user account gets it,
  and it unlocks every private repository they own — a strictly larger blast
  radius than ADR 0002 described. The Launcher is now a credential-holding
  process, and `no-credentials.test.ts` cannot see a runtime-entered token: it
  guards what is checked in, not what a user connects.
- **A Project that arrived with a remote saves back to it.** An imported Project
  (ADR 0005) keeps its own `origin`, and creating a *second* repository next to
  the one it came from is not what "save" means to the person who imported it.
  So container A reports `remote.origin.url`, and the host publishes there — but
  that URL lives in `.git/config`, which Claude can write, so it decides where
  the token pushes. It is trusted only if it parses as a plain GitHub repository
  (no other host, no embedded credentials) **and** `GET /repos/:owner/:repo` says
  this token has `push` permission. Asking GitHub rather than comparing against
  the connected login is what makes an organisation-owned repo work. Anything
  else falls back to the case below. The residual power this hands Claude —
  redirecting a save to another repo the Sandbox User can already push to — is
  inside what the `repo` token could do anyway, and the credential helper is
  scoped to `github.com` so no destination can be handed the token itself.
- **Otherwise** a private repo is created, named after the Project **slug**,
  never the friendly name — the name lives in metadata inside the Box and so
  Claude can write it, while the slug is `[a-z0-9-]` by construction and
  re-validated before it reaches any shell.
- **Publishing writes into the Project's own git, on purpose.** Saving stages
  whatever is in flight, writes a "Saved from Claudebox" commit onto the branch
  that is checked out, and advances it. That is what "normal git behaviour" costs
  and it is what was asked for: the history the Sandbox User sees in the Box is
  the history GitHub gets, an imported repo's real history included. A Project
  where uncommitted work should have stayed uncommitted has no way to say so —
  the button is "save everything", not "commit these files".
- Container A runs *under* the Project's `.git/config`, so a `core.fsmonitor` or
  `uploadpack.packObjectsHook` line Claude wrote does execute there. Accepted:
  that container holds no credential and mounts nothing Claude cannot already
  reach, so it gains exactly the privilege Claude already has. It is container B,
  which never sees that config, that holds the token.
- **A fixed exclude list, applied as a `core.excludesfile` for the publish `add`
  only** — so nothing is written into the Project and git inside the Box behaves
  as before. `node_modules` and friends because one `npm install` would otherwise
  make this a several-hundred-megabyte push — and `.env`, `*.pem`, `id_rsa`
  because that is where a Sandbox User's API keys live, and Claudebox pushing one
  to GitHub would be Claudebox exfiltrating a credential on their behalf. Most
  Projects have no `.gitignore` of their own, so "their ignore rules will catch
  it" is not a defence that exists; theirs still apply on top. A file already
  *tracked* in their repo is unaffected, which is ordinary git: by then they
  committed it themselves. Build output (`dist/`, `build/`) is deliberately not
  excluded: for a static site, that is the thing being saved.
- Both publish containers keep `--cap-add NET_ADMIN` and the IPv6 sysctls, so the
  Egress Policy applies to the credentialed container too.
- A branch changed on GitHub outside Claudebox stops publishing until someone
  resolves it by hand. Accepted: the alternative is `--force`.
- Claudebox does not clone *in* from GitHub. Import (ADR 0005) is the way in, and
  it needs no credential.
- **One account at a time**, swappable from the home screen: connecting replaces
  whatever was stored, and every Project publishes to the account connected now.
  Holding several at once would mean a host-side map of Project → account, and
  the Project's own metadata cannot hold that choice because Claude can write it.
  Not built until someone actually needs two accounts. The device flow authorises
  whichever account is signed in to the browser, so switching means signing out
  of github.com first — the connect sheet says so.
- One manual prerequisite per Claudebox build: a maintainer registers the OAuth
  App with **Enable Device Flow** ticked (GitHub otherwise answers
  `device_flow_disabled`) and pastes its client id into `core/config.ts`.
