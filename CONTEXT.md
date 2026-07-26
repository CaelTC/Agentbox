# Claudebox

A local development sandbox for running Claude Code on a colleague's computer. It exists so people who are not fluent in Git or coding can safely practice and play with Claude Code without risking their own machine or reaching company systems.

## Language

**Claudebox**:
The sandbox itself — the walled environment in which Claude Code runs on the user's laptop.

**Sandbox User**:
A non-technical colleague using Claudebox to learn. Assumed to have little or no Git/coding fluency.
_Avoid_: developer, engineer

**Threat Model**:
The harms Claudebox exists to prevent — (A) damage to the Sandbox User's own computer, and (B) any path from the sandbox to company systems, credentials, or private repos. Export adds (C): content produced inside the Box being executed on the host after the Sandbox User carries it across. The Box's walls cannot defend C, because C happens outside them.

**The Box**:
The Docker container that is Claudebox at runtime. The filesystem and network boundary that enforces the Threat Model.
_Avoid_: image (the image is the template; the Box is the running instance)

**Egress Policy**:
The Box's network rule — the whole public internet is reachable, but all private/local ranges (RFC-1918, link-local, the host gateway) are blocked. Defends threat B against LAN / on-prem systems.

**Credential Hygiene**:
The rule that the Box holds no company credentials — only credentials that grant access to Claude itself. Defends threat B against cloud-hosted company systems, which the Egress Policy cannot block.

**Login with Claude**:
The authentication method — the Sandbox User signs into their own claude.ai subscription seat via OAuth from inside the Box. The only credential the Box ever holds; grants Claude access and nothing else.
_Avoid_: API key (deliberately not used)

**Workspace**:
The Sandbox User's persistent project directory inside the Box, stored on a named Docker volume. Survives restarts. The Box has no access to the real host filesystem — the Workspace is the only place work lives.

**Project**:
A named unit of work inside the Workspace that the Sandbox User creates, resumes, and manages from the Launcher's home screen before entering a Claude Code chat.

**Launcher**:
The double-clickable app — macOS and Windows — that is the Sandbox User's entire interface to Claudebox. Trusted, host-side code (not Claude) that hides Docker: it starts the Box, shows the Project home screen, drops the user into Claude Code, and brokers file Uploads.

**Upload**:
A one-way, user-initiated copy of individual files from the Sandbox User's computer into an existing Project's Workspace, performed by the trusted Launcher via a native file picker. Claude never gets direct host filesystem access — it only sees the copies. Preserves threat A — true of picking a handful of files one at a time (a CSV, a script); not a claim this makes about carrying in a whole project, see Project Import for that.
_Avoid_: mount, shared folder (deliberately not a live bind-mount)

**Export**:
A one-way, user-initiated copy of Project documents out of the Box onto the Sandbox User's computer, performed by the trusted Launcher. The mirror of Upload. The Sandbox User picks the files, from a list the Launcher itself builds — the Box never names what crosses or where it lands. Only document-shaped files are offered, and the total is bounded, because an unbounded copy onto the host would be threat A. Carries threat C: what lands is document-shaped, not inert — a web file the Box wrote still runs script when it is opened. So every exported file is marked untrusted as it lands, in the host's own terms — `Zone.Identifier` on Windows, `com.apple.quarantine` on macOS — which is what makes Protected View, SmartScreen and Gatekeeper apply to it. The allowlist and the mark together reduce C to the risk class of an email attachment; they do not remove it, and it is the Sandbox User, not the Box, who decides whether to open what landed.
_Avoid_: download (nothing is fetched over a network), sync (it is not continuous and never deletes), bare save (collides with saving a file inside Claude Code — the button is "Save to my computer", which still says where it goes)

**Project Import**:
A one-way, user-initiated copy of a whole project folder from the Sandbox User's computer into a new Project's Workspace, performed by the trusted Launcher via a `tar` stream piped into `docker cp`. `.gitignore` is the only filter — tracked and untracked-but-not-ignored files cross; a folder with no `.gitignore` copies wholesale, and the confirmation sheet says so. `.git` always crosses too, history included, accepted deliberately. Carries threat B in full: `.git` holds every secret ever committed and later removed, plus the remote URL and private history, and the Egress Policy cannot stop it leaving over the open public internet from a container running Claude with permissions bypassed. The confirmation sheet is informed consent, not protection (ADR 0005).
_Avoid_: mirror of Export, the reverse of Export (Export carries documents *out* under an allowlist; Import carries a whole project *in*, unfiltered — the two are not symmetric)

**Delete Project**:
A one-way, user-initiated removal of a Project and everything in it from the Workspace, performed by the trusted Launcher. Permanent: there is no trash. The Workspace is a named volume with no host mount, so a deleted Project is not in the Sandbox User's own trash either — the Box held the only copy. A trash folder inside the Box was rejected deliberately, because it would go on charging the Resource Cap for work the Sandbox User believes they threw away, and the Resource Cap is what bounds threat A. What survives is whatever they had already Exported, which lives on their computer and is theirs; the Launcher does not reach back out and take it. The Project's tmux session is killed before its folder is removed — a session outlives its directory, and the funnel would otherwise re-attach the next Project with the same slug to the dead one. Confirmation is typing the Project's name, so this is never a slipped click.
_Avoid_: archive, close, remove from list (nothing is kept and nothing is merely hidden — the files are gone), the mirror of Import (Import brings a copy in and leaves the original alone; Delete destroys the only copy)

**Install Script**:
The one-time setup step, run by whoever provisions the machine (not the Sandbox User). Installs the Engine, Google Chrome (for the Project session window), the Launcher, and the initial Box image. Replaces a signed installer, which is not available. The Windows script needs Administrator (WSL2 and the Podman machine both do); the macOS one does not.

**Engine**:
The headless, license-free container runtime that runs the Box on the host in place of Docker Desktop — Colima on macOS, a Podman machine (WSL2, rootful) on Windows. Two runtimes, one property: neither is headed and neither carries a commercial licence (ADR 0004).

**Refresh on Launch**:
On every start, the Launcher pulls the latest Box definition from the public Claudebox GitHub repo and rebuilds the image if it changed, then runs `claude update` inside the running Box (the image's npm layer is cached, so a rebuild alone would keep shipping a stale Claude). This is the sole update mechanism. Requires no credentials because the repo is public. Both halves are best-effort: an offline laptop still opens on its last-built image and its baked Claude.

**Batteries**:
The tooling pre-baked into the Box so Claude can act instantly without per-session installs — Node.js, Python, Rust, git, a shell, and the mattpocock-skills Claude Code plugin (pre-installed so its skills are available with no setup).

**Web Preview**:
A port forwarded by the Launcher from the Box to a browser tab on the Sandbox User's computer, so they can see a page or app they built. The host reaching into the Box — does not weaken threat A or B.

**Resource Cap**:
The tuned, bounded Engine allocation baked into the Launcher (~4 CPU / 6 GB RAM / 25 GB disk cap). On macOS Colima enforces all three, and the disk cap bounds threat A — the Box can never grow past a known ceiling on the host. On Windows it is weaker and deliberately so: CPU and RAM come from a global `%USERPROFILE%\.wslconfig` shared with every other WSL distribution, and **there is no disk ceiling at all** — the VHDX grows on demand, so the cap is documented rather than enforced (ADR 0004).

**Starter Template**:
A one-click starting point on the Launcher home screen (e.g. "Build a personal webpage", "Make a guessing game", "Analyze a spreadsheet") that seeds a Project and a first prompt, so a Sandbox User is never faced with a blank chat.
