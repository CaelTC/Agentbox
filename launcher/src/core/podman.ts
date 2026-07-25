import { PODMAN_MACHINE, RESOURCE_CAP, type ResourceCap } from "./config";

/**
 * The `podman machine` args that run the Box's VM on Windows (issue #10), the
 * counterpart of core/colima.ts on the Mac. `podman machine init --cpus --memory
 * --disk-size` maps 1:1 onto colimaStartArgs with two differences: colima's
 * `start` is create-or-start in one command where podman splits `init` from
 * `start` (resolved in main/engine.ts), and the units below.
 */

/** colima's `--memory` is GiB; podman machine's is MiB. */
const MIB_PER_GIB = 1024;

/**
 * Create the Box's VM at the Resource Cap.
 *
 * Known limit, accepted: podman's WSL provider does not enforce per-machine
 * limits — CPU/RAM come from the global `%USERPROFILE%\.wslconfig` and the disk
 * is a dynamically-growing VHDX with no ceiling. So on Windows CONTEXT.md's
 * "the Box can never grow past a known ceiling on the host" is not yet true.
 * The cap is still passed: it is correct for the Hyper-V provider and it keeps
 * one Resource Cap as the single source of truth for both engines.
 */
export function podmanMachineInitArgs(
  cap: ResourceCap = RESOURCE_CAP,
  machine: string = PODMAN_MACHINE,
): string[] {
  return [
    "machine",
    "init",
    "--cpus",
    String(cap.cpu),
    "--memory",
    String(cap.memoryGiB * MIB_PER_GIB),
    "--disk-size",
    String(cap.diskGiB),
    machine,
  ];
}

export function podmanMachineStartArgs(machine: string = PODMAN_MACHINE): string[] {
  return ["machine", "start", machine];
}

export function podmanMachineInspectArgs(machine: string = PODMAN_MACHINE): string[] {
  return ["machine", "inspect", machine];
}

/**
 * Rootful, applied once at init time. `box/entrypoint.sh` hard-fails when
 * `apply-egress.sh` cannot install its rules, and boxRunArgs passes `--cap-add
 * NET_ADMIN` plus two `--sysctl net.ipv6.*` — rootless podman is exactly where
 * namespaced `net.*` sysctls get rejected and pasta/slirp4netns change the
 * gateway and resolver the egress script discovers. Rootless buys nothing here:
 * the boundary is the container, not podman's uid (ADR 0001), and the machine is
 * already a VM.
 */
export function podmanMachineSetRootfulArgs(machine: string = PODMAN_MACHINE): string[] {
  return ["machine", "set", "--rootful", machine];
}

/**
 * `podman machine inspect` prints a JSON array whose `State` is "running" when
 * the VM is up. Parsed defensively: a missing machine makes podman print a bare
 * error line, which must read as "not running" rather than throw.
 */
export function isPodmanMachineRunning(inspectOutput: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(inspectOutput);
  } catch {
    return false;
  }
  const machines = Array.isArray(parsed) ? parsed : [parsed];
  return machines.some((m) => (m as { State?: unknown } | null)?.State === "running");
}
