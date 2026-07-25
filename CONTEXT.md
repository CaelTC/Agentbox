# Claudebox

A local development sandbox for running Claude Code on a colleague's MacBook. It exists so people who are not fluent in Git or coding can safely practice and play with Claude Code without risking their own machine or reaching company systems.

## Language

**Claudebox**:
The sandbox itself — the walled environment in which Claude Code runs on the user's laptop.

**Sandbox User**:
A non-technical colleague using Claudebox to learn. Assumed to have little or no Git/coding fluency.
_Avoid_: developer, engineer

**Threat Model**:
The harms Claudebox exists to prevent — (A) damage to the Sandbox User's own MacBook, and (B) any path from the sandbox to company systems, credentials, or private repos. Export adds (C): content produced inside the Box being executed on the host after the Sandbox User carries it across. The Box's walls cannot defend C, because C happens outside them.

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
The Sandbox User's persistent project directory inside the Box, stored on a named Docker volume. Survives restarts. The Box has no access to the real MacBook filesystem — the Workspace is the only place work lives.

**Project**:
A named unit of work inside the Workspace that the Sandbox User creates, resumes, and manages from the Launcher's home screen before entering a Claude Code chat.

**Launcher**:
The double-clickable macOS app that is the Sandbox User's entire interface to Claudebox. Trusted, host-side code (not Claude) that hides Docker: it starts the Box, shows the Project home screen, drops the user into Claude Code, and brokers file Uploads.

**Upload**:
A one-way, user-initiated copy of files from the MacBook into a Project's Workspace, performed by the trusted Launcher via a native file picker. Claude never gets direct host filesystem access — it only sees the copies. Preserves threat A.
_Avoid_: mount, shared folder (deliberately not a live bind-mount)

**Export**:
A one-way, user-initiated copy of Project documents out of the Box onto the MacBook, performed by the trusted Launcher. The mirror of Upload. The Sandbox User picks the files, from a list the Launcher itself builds — the Box never names what crosses or where it lands. Only document-shaped files are offered, and the total is bounded, because an unbounded copy onto the host would be threat A. Carries threat C: what lands is document-shaped, not inert — a web file the Box wrote still runs script when it is opened. The allowlist reduces C to the risk class of an email attachment; it does not remove it, and it is the Sandbox User, not the Box, who decides whether to open what landed.
_Avoid_: download (nothing is fetched over a network), sync (it is not continuous and never deletes), bare save (collides with saving a file inside Claude Code — the button is "Save to my Mac", which says where it goes)

**Install Script**:
The one-time setup step, run by whoever provisions the MacBook (not the Sandbox User). Installs Colima, Google Chrome (for the Project session window), the Launcher, and the initial Box image. Replaces a signed installer, which is not available.

**Engine**:
Colima — the headless, license-free container runtime that runs the Box on the MacBook in place of Docker Desktop.

**Refresh on Launch**:
On every start, the Launcher pulls the latest Box definition from the public Claudebox GitHub repo and rebuilds the image if it changed, then runs `claude update` inside the running Box (the image's npm layer is cached, so a rebuild alone would keep shipping a stale Claude). This is the sole update mechanism. Requires no credentials because the repo is public. Both halves are best-effort: an offline laptop still opens on its last-built image and its baked Claude.

**Batteries**:
The tooling pre-baked into the Box so Claude can act instantly without per-session installs — Node.js, Python, Rust, git, a shell, and the mattpocock-skills Claude Code plugin (pre-installed so its skills are available with no setup).

**Web Preview**:
A port forwarded by the Launcher from the Box to a browser tab on the MacBook, so the Sandbox User can see a page or app they built. The laptop reaching into the Box — does not weaken threat A or B.

**Resource Cap**:
The tuned, bounded Colima allocation baked into the Launcher (~4 CPU / 6 GB RAM / 25 GB disk cap). The disk cap bounds threat A — the Box can never grow past a known ceiling on the host.

**Starter Template**:
A one-click starting point on the Launcher home screen (e.g. "Build a personal webpage", "Make a guessing game", "Analyze a spreadsheet") that seeds a Project and a first prompt, so a Sandbox User is never faced with a blank chat.
