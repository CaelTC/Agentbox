#Requires -Version 5.1
<#
install.ps1 - the one-time Install Script for Claudebox on Windows (issue #11).

The sibling of install.sh, with the same contract: run by whoever provisions the
laptop (NOT the Sandbox User). Installs the Engine (podman + its WSL2 machine)
and the Launcher, and prepares the initial Box image by cloning the PUBLIC
definition repo over HTTPS. No signed installer is used and NO credential is ever
configured - the repo is public by design, which is what closes threat B's
credential half by construction (ADR 0002).

Two things differ from the Mac and are worth saying out loud:

  * It needs ADMINISTRATOR. `wsl --install` and several winget packages do.
    install.sh needs no sudo beyond Homebrew; this does.
  * A machine that has never had WSL2 must RESTART once, part-way through. The
    script says so plainly and stops; re-run it after the restart and it carries
    on. Every step is idempotent, so re-running is always safe.

Usage (from an elevated PowerShell):

    powershell -ExecutionPolicy Bypass -File install.ps1

Kept deliberately ASCII-only: Windows PowerShell 5.1 reads a BOM-less .ps1 as
ANSI, and mojibake in a provisioning log helps nobody. Keep it that way.
#>

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

# The public definition repo. HTTPS, no auth. A copy of DEFINITION_REPO in
# launcher/src/core/config.ts - as are $PodmanMachine, $BoxImage and the Cap
# below. launcher/test/config.test.ts fails if any of them drifts.
$DefinitionRepo = 'https://github.com/CaelTC/Claudebox.git'

$ClaudeboxHome = if ($env:CLAUDEBOX_HOME) { $env:CLAUDEBOX_HOME }
                 else { Join-Path $env:USERPROFILE '.claudebox' }
$DefinitionDir = Join-Path $ClaudeboxHome 'definition'

# Where the Launcher lands. Per-user, like /Applications is per-Mac: see the NOTE
# in Install-Launcher about which account should run this script.
$ProgramsDir = if ($env:CLAUDEBOX_PROGRAMS) { $env:CLAUDEBOX_PROGRAMS }
               else { Join-Path (Join-Path $env:LOCALAPPDATA 'Programs') 'Claudebox' }

# The prebuilt Launcher, cross-packaged from a Mac (`npm run package:win`) and
# committed into the definition repo - the mirror of install.sh's Claudebox.app.
$LauncherFolder = 'Claudebox-win32-x64'
$LauncherExe = 'Claudebox.exe'

# The Engine. ENGINE_PROFILE and BOX_IMAGE from launcher/src/core/config.ts; the
# init flags mirror main/podman.ts.
$PodmanMachine = 'claudebox'
$BoxImage = 'claudebox:latest'

# The Resource Cap (CONTEXT.md), the same numbers as RESOURCE_CAP in
# launcher/src/core/config.ts. See Write-WslConfig for what Windows can and
# cannot actually enforce.
$CapCpu = 4
$CapMemoryGiB = 6
$CapDiskGiB = 25

# winget, not chocolatey: it ships with Windows 10 1809+ and Windows 11, so
# unlike install.sh's Homebrew bootstrap there is nothing to install first.
#
# No browser is listed. The Launcher draws the Project session window itself,
# and Preview opens in whatever browser Windows already treats as default — so
# provisioning has no browser to choose on the user's behalf.
$WingetPackages = @(
  @{ Id = 'RedHat.Podman'; What = 'the Engine (podman)' },
  @{ Id = 'Git.Git';       What = 'git (to fetch the Box definition)' }
)

function Write-Log {
  param([string]$Message)
  Write-Host "[install] $Message" -ForegroundColor Cyan
}

# The equivalent of install.sh's `set -e` for native commands: PowerShell does
# not stop on a non-zero exe, so every engine/git/winget call goes through here.
# Takes a script block rather than an exe + args so the call sites read like the
# shell commands they are, with no parameter-binding games over `--flags`.
function Invoke-Checked {
  param([Parameter(Mandatory = $true)][scriptblock]$Command)
  & $Command
  if ($LASTEXITCODE -ne 0) {
    throw "'$($Command.ToString().Trim())' failed with exit code $LASTEXITCODE."
  }
}

# The opposite of Invoke-Checked: run a command purely for its exit code, where
# a non-zero answer is information rather than a failure ("is WSL there?", "does
# the machine exist?").
#
# The relaxed preference is load-bearing on Windows PowerShell 5.1 - which is
# what ships in the box, and what this script is written for. When a native
# command writes to stderr AND stderr is redirected, 5.1 wraps the output in a
# NativeCommandError record; with $ErrorActionPreference = 'Stop' that record is
# TERMINATING. So `wsl.exe --status` on a machine with no WSL - the very first
# probe this installer makes - would abort the script instead of returning
# non-zero, and the "restart Windows and run this again" message would never be
# reached. PowerShell 7 does not behave this way; 5.1 does.
function Invoke-Probe {
  param([Parameter(Mandatory = $true)][scriptblock]$Command)
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $Command *> $null
    return $LASTEXITCODE
  }
  finally {
    $ErrorActionPreference = $previous
  }
}

# winget installs put podman and git on the machine PATH, but not into a shell
# that was already open. Without this, a fresh machine would install the Engine
# and then fail to find it two steps later.
function Update-SessionPath {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = (@($machine, $user) | Where-Object { $_ }) -join ';'
}

# --- 1. Require Administrator - the mirror of require_macos -------------------
function Require-Administrator {
  if ($env:OS -ne 'Windows_NT') {
    throw 'This installer is the Windows half of Claudebox. On a Mac, run install.sh.'
  }
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw @'
This installer must run as Administrator: enabling WSL2 and installing the
Engine both need it. Right-click PowerShell, "Run as administrator", then:

    powershell -ExecutionPolicy Bypass -File install.ps1
'@
  }
}

# --- 2. WSL2, and the one restart --------------------------------------------
# The podman machine is a WSL2 distro, and enabling WSL2 on a fresh machine needs
# a restart. There is one honest way to handle that: tell the human, and stop.
# No RunOnce registry state machine for a step that happens once ever - the whole
# script is re-runnable, so "restart and run it again" is the entire recovery.
function Test-Wsl2Ready {
  if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) { return $false }
  # wsl.exe writes UTF-16 by default, which turns any text match into a trap.
  # We only need the exit code, and WSL_UTF8 keeps the output readable for the
  # human watching.
  $env:WSL_UTF8 = '1'
  return ((Invoke-Probe { wsl.exe --status }) -eq 0)
}

function Install-Wsl2 {
  if (Test-Wsl2Ready) {
    Write-Log 'WSL2 is already enabled.'
    return
  }

  Write-Log 'Enabling WSL2 (no distribution - the podman machine brings its own)...'
  & wsl.exe --install --no-distribution
  if ($LASTEXITCODE -ne 0) {
    throw @'
Could not enable WSL2 automatically. This needs Windows 10 version 2004 or
newer. On an older build, enable the "Virtual Machine Platform" and "Windows
Subsystem for Linux" features by hand, restart, and run this script again.
'@
  }

  Write-Host ''
  Write-Host 'WSL2 is enabled, but Windows must RESTART before it works.' -ForegroundColor Yellow
  Write-Host 'Restart Windows and run this script again. It will carry on from here.' -ForegroundColor Yellow
  Write-Host ''
  exit 1
}

# --- 3. The Engine and git ---------------------------------------------------
function Install-Packages {
  if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) {
    throw @'
winget is missing. It ships with Windows 10 1809+ and Windows 11 as "App
Installer" - install that from the Microsoft Store and run this script again.
'@
  }

  foreach ($package in $WingetPackages) {
    if ((Invoke-Probe { winget.exe list --id $package.Id --exact --source winget }) -eq 0) {
      Write-Log "$($package.What) already present."
      continue
    }
    Write-Log "Installing $($package.What)..."
    $id = $package.Id
    Invoke-Checked {
      winget.exe install --id $id --exact --source winget `
        --silent --accept-package-agreements --accept-source-agreements
    }
  }

  Update-SessionPath
}

# --- 4. The Resource Cap, as far as Windows will honour it -------------------
# This is the honest-but-weaker half of the cap: .wslconfig limits are GLOBAL to
# every WSL distro on the machine, not per-machine, and there is NO disk ceiling:
# podman's WSL provider grows a dynamic VHDX. So CONTEXT.md's "the Box can
# never grow past a known ceiling on the host" is not yet true here (the same
# limit is recorded in launcher/src/main/podman.ts, and in ADR 0004, issue 3/3).
function Write-WslConfig {
  $path = Join-Path $env:USERPROFILE '.wslconfig'
  $marker = '# Written by Claudebox install.ps1 - the Resource Cap (CONTEXT.md).'
  $desired = @(
    $marker,
    '# NOTE: these limits apply to EVERY WSL distro on this machine, and there is',
    '#       no disk ceiling. Both are accepted limits of the Windows port.',
    '[wsl2]',
    "processors=$CapCpu",
    "memory=$($CapMemoryGiB)GB"
  ) -join "`r`n"

  if (Test-Path $path) {
    $existing = Get-Content -Path $path -Raw
    if ($existing -eq ($desired + "`r`n")) {
      Write-Log 'Resource Cap already written to .wslconfig.'
      return
    }
    if ($existing -notmatch [regex]::Escape($marker)) {
      # Someone else's file. Never silently discard it.
      $backup = "$path.claudebox-backup"
      Copy-Item -Path $path -Destination $backup -Force
      Write-Log "NOTE: an existing .wslconfig was backed up to $backup before writing the Resource Cap."
    }
  }

  Write-Log "Writing the Resource Cap ($CapCpu CPU / $CapMemoryGiB GB) to $path..."
  Set-Content -Path $path -Value $desired -Encoding ASCII
  # .wslconfig is read when WSL next starts, so a running WSL would keep the old
  # allocation. Shut it down now, before the podman machine is created.
  if (Test-Wsl2Ready) { [void](Invoke-Probe { wsl.exe --shutdown }) }
}

# --- 5. Fetch the public Box definition (no credentials) ---------------------
function Get-Definition {
  Write-Log 'Fetching the Box definition from the public repo...'
  # Belt and braces on ADR 0002: even if this machine has a credential helper
  # configured, git must never be able to prompt for or attach one here.
  $env:GIT_TERMINAL_PROMPT = '0'
  New-Item -ItemType Directory -Force -Path $ClaudeboxHome | Out-Null
  if (Test-Path (Join-Path $DefinitionDir '.git')) {
    Invoke-Checked { git -C $DefinitionDir pull --ff-only }
  }
  else {
    # Public HTTPS clone. No SSH key, no token, no credential helper.
    Invoke-Checked { git clone --depth 1 $DefinitionRepo $DefinitionDir }
  }
}

# --- 6. The Box's VM: podman machine at the cap, rootful ---------------------
# The same sequence as launcher/src/main/engine.ts: `colima start` is
# create-or-start in one command where podman splits init from start. Rootless
# podman is exactly where the namespaced net.ipv6 sysctls get rejected and where
# pasta/slirp4netns move the gateway and resolver that apply-egress.sh discovers
# (see main/podman.ts), so rootful is not optional here.
function Start-Machine {
  if ((Invoke-Probe { podman machine inspect $PodmanMachine }) -ne 0) {
    Write-Log "Creating the podman machine '$PodmanMachine' at the Resource Cap..."
    # podman machine's --memory is MiB where colima's is GiB (main/podman.ts).
    $memoryMiB = $CapMemoryGiB * 1024
    Invoke-Checked {
      podman machine init `
        --cpus $CapCpu `
        --memory $memoryMiB `
        --disk-size $CapDiskGiB `
        $PodmanMachine
    }
  }

  if (Test-MachineRunning) {
    Write-Log "The podman machine '$PodmanMachine' is already running."
    return
  }

  # Rootful is set on every run where the machine is down, not once at init: if
  # `init` succeeded and this failed, pinning it to the init branch would skip it
  # on every later run and leave the machine rootless forever, self-healing only
  # by deleting the VM. Re-applying it is a no-op when it is already set. It sits
  # below the running check because podman refuses the change on a live machine.
  Invoke-Checked { podman machine set --rootful $PodmanMachine }

  Write-Log "Starting the podman machine '$PodmanMachine'..."
  Invoke-Checked { podman machine start $PodmanMachine }
}

# `--format` leaves podman to parse its own JSON and print the state alone, as
# main/podman.ts's podmanMachineInspectArgs does. A missing machine exits
# non-zero, which must read as "not running" rather than fail the install - and
# it reaches that non-zero only because the preference is relaxed around the
# call: a missing machine writes to stderr, and this redirects stderr, which is
# precisely the 5.1 trap Invoke-Probe exists for (see its comment). Not routed
# through Invoke-Probe itself because this needs the stdout, not just the code.
function Test-MachineRunning {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $output = & podman machine inspect --format '{{.State}}' $PodmanMachine 2>$null
  }
  finally {
    $ErrorActionPreference = $previous
  }
  if ($LASTEXITCODE -ne 0) { return $false }
  return ($output | Out-String).Trim() -eq 'running'
}

# --- 7. Prepare the initial Box image ----------------------------------------
function Build-Image {
  Write-Log 'Building the initial Box image...'
  $context = Join-Path $DefinitionDir 'box'
  Invoke-Checked { podman build -t $BoxImage $context }
}

# --- 8. Prove the walls hold - hard-fail if they don't ------------------------
# box/egress/verify-egress.sh, run as the container command in a throwaway Box.
# The entrypoint applies the firewall BEFORE handing off, and refuses to start if
# it cannot - so this one command is also the proof that rootful podman on WSL
# grants working NET_ADMIN, in-container iptables and the IPv6 sysctls. If the
# walls don't hold, this installer stops: a Box that cannot enforce the Egress
# Policy must never accept a Sandbox User (ADR 0001, threat B).
function Test-Egress {
  Write-Log 'Checking the Egress Policy inside a throwaway Box...'
  & podman run --rm `
    --cap-add NET_ADMIN `
    --sysctl net.ipv6.conf.all.disable_ipv6=1 `
    --sysctl net.ipv6.conf.default.disable_ipv6=1 `
    $BoxImage /usr/local/bin/verify-egress.sh
  if ($LASTEXITCODE -ne 0) {
    throw @'
The Egress Policy did not hold, so the install is stopping here. The Box would
have been able to reach this machine or the network it sits on (threat B).
Nothing has been installed to the Start Menu; re-run once the cause is fixed.
'@
  }
}

# --- 9. Install the Launcher + a Start Menu entry ----------------------------
# A folder copy and a shortcut - the direct mirror of install_launcher(). No NSIS
# installer, no electron-builder: no new build dependency, no change to the Mac
# packaging path, and a script-copied exe carries no Mark-of-the-Web, so it dodges
# the SmartScreen prompt an unsigned downloaded installer would trigger.
function Install-Launcher {
  $source = Join-Path (Join-Path $DefinitionDir 'launcher') $LauncherFolder
  if (-not (Test-Path $source)) {
    Write-Log "NOTE: no prebuilt $LauncherFolder found; build it with 'npm run package:win' in launcher/."
    return
  }

  Write-Log "Installing the Launcher into $ProgramsDir..."
  if (Test-Path $ProgramsDir) { Remove-Item -Path $ProgramsDir -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $ProgramsDir | Out-Null
  Copy-Item -Path (Join-Path $source '*') -Destination $ProgramsDir -Recurse -Force

  $target = Join-Path $ProgramsDir $LauncherExe
  $startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
  New-Item -ItemType Directory -Force -Path $startMenu | Out-Null

  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut((Join-Path $startMenu 'Claudebox.lnk'))
  $shortcut.TargetPath = $target
  $shortcut.WorkingDirectory = $ProgramsDir
  $shortcut.Description = 'Claudebox - a safe sandbox for practising with Claude Code.'
  $shortcut.Save()

  Write-Log 'Start Menu entry created.'
  Write-Log 'NOTE: the Launcher and its Start Menu entry are installed for the account'
  Write-Log '      running this script. Run it from the Sandbox User''s own account'
  Write-Log '      (elevating when Windows asks) so both land in their profile.'
}

function Main {
  Require-Administrator
  Install-Wsl2
  Install-Packages
  Write-WslConfig
  Get-Definition
  Start-Machine
  Build-Image
  Test-Egress
  Install-Launcher
  Write-Log 'Done. The Sandbox User can now open Claudebox from the Start Menu.'
}

try {
  Main
}
catch {
  Write-Host ''
  Write-Host "[install] $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
