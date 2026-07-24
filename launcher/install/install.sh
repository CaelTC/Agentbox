#!/usr/bin/env bash
#
# install.sh — the one-time Install Script for Claudebox (ticket 09 / ADR 0002).
#
# Run by whoever provisions the MacBook (NOT the Sandbox User). Installs the
# Engine (Colima) and the Launcher, and prepares the initial Box image by
# cloning the PUBLIC definition repo over HTTPS. No signed installer is used and
# NO credential is ever configured — the repo is public by design, which is what
# closes threat B's credential half by construction.
set -euo pipefail

# The single source of truth for the public definition repo. HTTPS, no auth.
DEFINITION_REPO="https://github.com/claudebox/claudebox.git"
CLAUDEBOX_HOME="${CLAUDEBOX_HOME:-$HOME/.claudebox}"
APPLICATIONS_DIR="${APPLICATIONS_DIR:-/Applications}"

log() { printf '\033[36m[install]\033[0m %s\n' "$*"; }

require_macos() {
  if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "Claudebox targets macOS. This installer must run on a Mac." >&2
    exit 1
  fi
}

install_homebrew_if_needed() {
  if ! command -v brew >/dev/null 2>&1; then
    log "Installing Homebrew (needed to install Colima)…"
    /bin/bash -c \
      "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  fi
}

# --- 1. Engine: Colima + the Docker CLI --------------------------------------
install_engine() {
  log "Installing the Engine (Colima) and Docker CLI…"
  brew install colima docker
}

# --- 2. Fetch the public Box definition (no credentials) ---------------------
fetch_definition() {
  log "Fetching the Box definition from the public repo…"
  mkdir -p "$CLAUDEBOX_HOME"
  if [[ -d "$CLAUDEBOX_HOME/definition/.git" ]]; then
    git -C "$CLAUDEBOX_HOME/definition" pull --ff-only
  else
    # Public HTTPS clone. No SSH key, no token, no credential helper.
    git clone --depth 1 "$DEFINITION_REPO" "$CLAUDEBOX_HOME/definition"
  fi
}

# --- 3. Prepare the initial Box image ----------------------------------------
prepare_image() {
  log "Preparing the initial Box image…"
  colima start --profile claudebox --cpu 4 --memory 6 --disk 25
  docker build -t claudebox:latest "$CLAUDEBOX_HOME/definition/box"
}

# --- 4. Install the Launcher into /Applications ------------------------------
install_launcher() {
  log "Installing the Launcher into ${APPLICATIONS_DIR}…"
  # The Launcher is an unsigned .app built from launcher/. The provisioner copies
  # the built app bundle here; running it locally needs no signing.
  if [[ -d "$CLAUDEBOX_HOME/definition/launcher/Claudebox.app" ]]; then
    cp -R "$CLAUDEBOX_HOME/definition/launcher/Claudebox.app" "$APPLICATIONS_DIR/"
  else
    log "NOTE: no prebuilt Claudebox.app found; build it with 'npm run build' in launcher/."
  fi
}

main() {
  require_macos
  install_homebrew_if_needed
  install_engine
  fetch_definition
  prepare_image
  install_launcher
  log "Done. The Sandbox User can now open Claudebox from Applications."
}

main "$@"
