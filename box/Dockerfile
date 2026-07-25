# syntax=docker/dockerfile:1
#
# The Box — the Docker image that is Claudebox at runtime (CONTEXT.md: "The Box").
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

# Rust via rustup, installed system-wide so every session sees `cargo`/`rustc`.
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
      | sh -s -- -y --no-modify-path --profile minimal \
  && chmod -R a+rwX /usr/local/cargo /usr/local/rustup

# --- Claude Code (ticket 01) -------------------------------------------------
RUN npm install -g @anthropic-ai/claude-code

# --- Non-root user -----------------------------------------------------------
# Claude runs as an unprivileged user; the entrypoint uses sudo only to install
# the egress firewall at startup (ticket 02).
RUN useradd --create-home --shell /bin/bash sandbox \
  && echo 'sandbox ALL=(root) NOPASSWD: /usr/local/bin/apply-egress.sh' > /etc/sudoers.d/egress \
  && chmod 0440 /etc/sudoers.d/egress

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
COPY bin/claudebox-session /usr/local/bin/claudebox-session
COPY terminal/ /opt/terminal/
RUN chmod +x /usr/local/bin/apply-egress.sh /usr/local/bin/verify-egress.sh \
      /usr/local/bin/entrypoint.sh /usr/local/bin/start-terminal.sh \
      /usr/local/bin/claudebox-session

# The Workspace mounts here as a named volume. Owning it as `sandbox` before the
# volume is created means the fresh named volume inherits that ownership, so
# Claude can write to its own Workspace.
RUN mkdir -p /workspace && chown -R sandbox:sandbox /workspace

# --- The mattpocock-skills plugin, pre-installed (ticket 03) -----------------
# Installed AS the sandbox user so it lands in /home/sandbox/.claude, where the
# session (which runs as sandbox) can see it. Best-effort: the exact plugin CLI
# depends on the Claude Code build, so a failure warns rather than breaking the
# build — see box/README.md. NOTE: this runs before any VOLUME on /home/sandbox
# so the baked plugin is copied into the home volume on first run.
USER sandbox
RUN claude plugin marketplace add mattpocock/mattpocock-skills \
  && claude plugin install mattpocock-skills@mattpocock-skills --yes \
  || echo "WARN: plugin pre-install step needs the running Claude Code plugin CLI; see box/README.md"

# The Workspace lives on a named volume mounted here (ADR 0001). /home/sandbox is
# ALSO mounted as a named volume at run time (to persist the Claude login) but is
# deliberately NOT declared VOLUME here, so the baked plugin above is preserved.
VOLUME ["/workspace"]
WORKDIR /workspace

# Apply the egress firewall, then run the container command (default: stay alive
# so the Launcher can exec Claude sessions into the Box).
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["sleep", "infinity"]
