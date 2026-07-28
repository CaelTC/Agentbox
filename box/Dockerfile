# syntax=docker/dockerfile:1
#
# The Box — the Docker image that is Agentbox at runtime (CONTEXT.md: "The Box").
# This file is intentionally PUBLIC and contains no secrets (ADR 0002).
#
# Ticket 01 (walking skeleton): a base image with Claude Code installed.
# Ticket 02 (egress hardening):  iptables + the entrypoint that applies rules.
# Ticket 03 (batteries):         Node, Python, Rust, git + the mattpocock plugin.

FROM node:22-bookworm

# --- Batteries: system runtimes & tools (ticket 03) --------------------------
# Installed once at build time so a Sandbox User never waits for a per-session
# install. Node.js comes from the base image. `iproute2` provides `ss`, used by
# Web Preview to detect the served port (ticket 07).
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
       python3 \
       python3-pip \
       python3-venv \
       git \
       curl \
       ca-certificates \
       iptables \
       ipset \
       iproute2 \
       sudo \
       tmux \
  && rm -rf /var/lib/apt/lists/*

# Web console: a small Starlette app (served in-Box) giving the Mac's browser a
# sablebox-style console — session tabs, a toggleable rail, a Files view — bridged
# to tmux over a WebSocket (replaces ttyd). Isolated in a venv; pinned (ADR 0002).
RUN python3 -m venv /opt/terminal-venv \
  && /opt/terminal-venv/bin/pip install --no-cache-dir \
       starlette==0.37.2 \
       jinja2==3.1.4 \
       uvicorn==0.30.6 \
       websockets==12.0

# --- Non-root user -----------------------------------------------------------
# Claude runs as an unprivileged user; the entrypoint uses sudo only to install
# the egress firewall at startup (ticket 02). Created before the Rust install so
# the toolchain below can be owned by it in the same layer.
RUN useradd --create-home --shell /bin/bash sandbox \
  && echo 'sandbox ALL=(root) NOPASSWD: /usr/local/bin/apply-egress.sh' > /etc/sudoers.d/egress \
  && chmod 0440 /etc/sudoers.d/egress

# Rust via rustup, installed system-wide so every session sees `cargo`/`rustc`.
# Owned by `sandbox` — NOT world-writable: /usr/local/cargo/bin is first on this
# PATH, and a world-writable directory on root's PATH is a plant-a-binary root
# escalation. The Launcher's root execs also carry their own sanitized PATH
# (launcher config.BOX_ROOT_PATH) and never resolve through here.
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
      | sh -s -- -y --no-modify-path --profile minimal \
  && chown -R sandbox:sandbox /usr/local/cargo /usr/local/rustup

# --- Claude Code (ticket 01) -------------------------------------------------
RUN npm install -g @anthropic-ai/claude-code

COPY egress/apply-egress.sh /usr/local/bin/apply-egress.sh
# The live proof that the rules above actually hold (issue #11). Run once by the
# Install Script, as the container command — the entrypoint applies the firewall
# first, so a single `run … verify-egress.sh` also proves NET_ADMIN, in-container
# iptables and the IPv6 sysctls work under whatever engine is hosting the Box.
COPY egress/verify-egress.sh /usr/local/bin/verify-egress.sh
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
COPY start-terminal.sh /usr/local/bin/start-terminal.sh
# The single funnel that turns a Project slug into its Claude session (ticket 02).
# Both the console and the Launcher launch a Project only through this program.
COPY bin/agentbox-session /usr/local/bin/agentbox-session
COPY terminal/ /opt/terminal/
RUN chmod +x /usr/local/bin/apply-egress.sh /usr/local/bin/verify-egress.sh \
      /usr/local/bin/entrypoint.sh /usr/local/bin/start-terminal.sh \
      /usr/local/bin/agentbox-session

# The Workspace mounts here as a named volume. Owning it as `sandbox` before the
# volume is created means the fresh named volume inherits that ownership, so
# Claude can write to its own Workspace.
RUN mkdir -p /workspace && chown -R sandbox:sandbox /workspace

# Save to GitHub's scratch volume (ADR 0006) mounts here, in the two ephemeral
# publish containers only — the long-lived Box never mounts it. Same trick as
# /workspace above: own the directory in the image, so the fresh named volume
# inherits it and the unprivileged `sandbox` user can write the bundle. Without
# this the volume is created root-owned and `git bundle create` gets EACCES.
RUN mkdir -p /scratch && chown sandbox:sandbox /scratch

# --- The mattpocock-skills plugin, pre-installed (ticket 03) -----------------
# Installed AS the sandbox user so it lands in /home/sandbox/.claude, where the
# session (which runs as sandbox) can see it. NOTE: this runs before any VOLUME
# on /home/sandbox so the baked plugin is copied into the home volume on first
# run — and entrypoint.sh tops it up for home volumes that predate the bake.
#
# Three details this invocation cannot get wrong (each one silently produced an
# empty /plugin list before):
#   * the repository is mattpocock/skills — there is no mattpocock-skills repo;
#   * the `owner/repo` shorthand clones over SSH, and the Box has no GitHub key,
#     so the HTTPS URL is the only form that authenticates here;
#   * the marketplace declares itself as `mattpocock`, so the plugin's id is
#     mattpocock-skills@mattpocock.
# No `|| true` — Batteries that fail to install must break the build, not the
# Sandbox User's first session.
USER sandbox
RUN claude plugin marketplace add https://github.com/mattpocock/skills.git \
  && claude plugin install mattpocock-skills@mattpocock --scope user

# The Workspace lives on a named volume mounted here (ADR 0001). /home/sandbox is
# ALSO mounted as a named volume at run time (to persist the Claude login) but is
# deliberately NOT declared VOLUME here, so the baked plugin above is preserved.
VOLUME ["/workspace"]
WORKDIR /workspace

# Apply the egress firewall, then run the container command (default: stay alive
# so the Launcher can exec Claude sessions into the Box).
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["sleep", "infinity"]
