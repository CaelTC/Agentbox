# Windows runs on rootful Podman/WSL2, without a disk cap

## Status

accepted

## Context

Agentbox was built for MacBooks: Colima gives it a headless, licence-free
container runtime and a **Resource Cap** — `colima start --cpu 4 --memory 6
--disk 25` — that bounds the Box at a known ceiling on the host. ADR 0001 leans
on that cap for threat A: the Box can damage the laptop neither by reaching its
files (no host mounts) nor by filling its disk (the cap).

Colleagues on Windows need the same sandbox. Colima has no Windows build, so the
Engine there is **Podman machine**, which runs the Box in a Linux VM the same way
Colima does. Podman machine on Windows has two providers, and neither reproduces
what Colima gives us for free:

- **WSL** (the default, and the only one on Windows Home) does not own its VM's
  resources. CPU and memory come from `%USERPROFILE%\.wslconfig`, which is
  **global to every WSL distribution on the machine** — it is the user's setting,
  not Agentbox's — and disk is a dynamically-growing VHDX with no ceiling we
  set. `podman machine set --cpus/--memory/--disk-size` is not honoured there.
- **Hyper-V** does honour those flags per machine, but Hyper-V is absent from
  Windows Home, which is what a colleague's own laptop usually runs.

The Box itself is unchanged: the same image, the same `entrypoint.sh`, the same
egress firewall. What changes is what the host promises about the Box's size.

## Decision

Ship Windows on **Podman machine over WSL2, rootful**, and accept that **the
disk cap is documented rather than enforced there**.

1. **Two Engines, one property.** Colima on macOS, Podman machine on Windows.
   CONTEXT.md's Engine entry cares that the runtime is headless and licence-free;
   both are. Docker Desktop is not, which is why neither is it.
2. **CPU and RAM on Windows come from a global `.wslconfig`**, written by the
   Install Script. It is a machine-wide setting, so it is a request the Launcher
   makes of the host, not a bound the Launcher imposes on the Box.
3. **There is no disk ceiling on Windows.** The WSL VHDX grows on demand. Threat
   A's "the Box can never grow past a known ceiling on the host" does **not hold
   there**, and CONTEXT.md's Resource Cap entry now says so per platform instead
   of stating a guarantee that is true on one of the two hosts we ship to.
4. **The Podman machine is rootful.** `entrypoint.sh` fail-closes when it cannot
   apply the egress policy, which needs `NET_ADMIN`, `iptables` and `net.*`
   sysctls — precisely what rootless Podman does not grant. A Box that cannot
   raise its firewall refuses to start (ADR 0001), so rootless would mean no Box
   at all, not a slightly weaker one.

## Considered Options

- **`CONTAINERS_MACHINE_PROVIDER=hyperv`** — rejected as the default, not as an
  idea. It restores per-machine `--cpus/--memory/--disk-size`, and it is the
  documented reversal for a fleet that is entirely Windows Pro/Enterprise. It is
  not the default because it does not exist on Home, and an Engine that works on
  some colleagues' laptops is worse than one that works on all of them with a
  named, written-down weakness.
- **Docker Desktop on Windows** — rejected: it enforces limits and would close
  this gap, but it reintroduces exactly the commercial-licence problem Colima was
  chosen to avoid on macOS. Trading a documented threat-A bound for a licence
  liability is not a trade this project makes.
- **Rootless Podman** — rejected: see 4. The egress policy is load-bearing for
  threat B and the container is the boundary (ADR 0001), not Podman's uid. The
  machine is already a VM the Sandbox User does not share with anything else.
- **A Launcher-side disk watchdog** (stop the Box when the VHDX passes 25 GB) —
  rejected for now: it is a monitor, not a bound, and a wrong one would stop a
  Sandbox User's work mid-sentence. Worth revisiting if a Box ever actually fills
  a colleague's disk.

## Consequences

- **Threat A is weaker on Windows than on macOS, and the difference is a disk
  ceiling.** The other half of threat A — no host mounts, so the Box cannot touch
  a single real file — is identical on both. A runaway Project on Windows fills
  the user's disk; on macOS it hits 25 GB and stops.
- The Windows Install Script needs **Administrator** (WSL2 and the Podman machine
  both do), where the macOS one does not. It is run by whoever provisions the
  machine, not the Sandbox User, so this is a provisioning note rather than a new
  ask of colleagues.
- Writing `.wslconfig` touches a **machine-global** file. The Install Script
  therefore states what it changed, and a colleague who has tuned WSL for
  something else keeps their own numbers.
- The reversal is one environment variable on a Pro/Enterprise fleet. If that day
  comes, this ADR is superseded rather than amended: the cap would then be a real
  bound on both platforms again, and CONTEXT.md's Resource Cap entry could drop
  its per-platform clause.
