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

# The public definition repo. HTTPS, no auth. This, the Resource Cap in
# prepare_image() and the image tag it builds are copies of core/config.ts —
# launcher/test/config.test.ts fails if any of them drifts.
DEFINITION_REPO="https://github.com/CaelTC/Claudebox.git"
CLAUDEBOX_HOME="${CLAUDEBOX_HOME:-$HOME/.claudebox}"
APPLICATIONS_DIR="${APPLICATIONS_DIR:-/Applications}"
LAUNCHER_SRC="$CLAUDEBOX_HOME/definition/launcher"

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

# No browser is installed here. The Launcher draws the Project session window
# itself, and Preview opens in whatever browser the Mac already treats as
# default — so provisioning has no browser to choose on the user's behalf.

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

# --- 4. Build the Launcher from the definition we just fetched ---------------
# The .app is a build product, so it is not in the repo and cannot be: the clone
# above is source. Building it here rather than downloading a bundle is also what
# keeps Gatekeeper out of the way — a locally built app carries no
# com.apple.quarantine, which an unsigned app fetched over HTTPS would (ADR 0002
# rules out signing, so the quarantine flag is the whole difference between "it
# opens" and "macOS refuses to open it").
build_launcher() {
  if ! command -v npm >/dev/null 2>&1; then
    log "Installing Node (needed to build the Launcher)…"
    brew install node
  fi
  log "Building the Launcher (this takes a few minutes the first time)…"
  npm --prefix "$LAUNCHER_SRC" ci
  npm --prefix "$LAUNCHER_SRC" run package
}

# --- 5. Install the Launcher into /Applications ------------------------------
install_launcher() {
  # electron-packager names the folder after the host arch, so match rather than
  # guess: one provisioner's Mac is arm64, the next one's is x64.
  local built=("$LAUNCHER_SRC"/release/Claudebox-darwin-*/Claudebox.app)
  if [[ ! -d "${built[0]}" ]]; then
    echo "The Launcher did not build — nothing to install." >&2
    exit 1
  fi

  log "Installing the Launcher into ${APPLICATIONS_DIR}…"
  # Replaced, not merged: `cp -R` over a live bundle leaves the previous version's
  # files behind inside it, and a half-old .app is worse than no .app.
  rm -rf "${APPLICATIONS_DIR:?}/Claudebox.app"
  cp -R "${built[0]}" "$APPLICATIONS_DIR/"
}

main() {
  require_macos
  install_homebrew_if_needed
  install_engine
  fetch_definition
  prepare_image
  build_launcher
  install_launcher
  log "Done. The Sandbox User can now open Claudebox from Applications."
}

main "$@"
