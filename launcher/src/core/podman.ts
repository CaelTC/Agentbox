import { ENGINE_PROFILE, RESOURCE_CAP, type ResourceCap } from "./config";

/**
 * The `podman machine` args that run the Box's VM on Windows (issue #10), the
 * counterpart of core/colima.ts on the Mac.
 */

/** colima's `--memory` is GiB; podman machine's is MiB. */
const MIB_PER_GIB = 1024;

/**
 * Create the Box's VM at the Resource Cap.
 *
 * Known limit, accepted: podman's WSL provider does not enforce per-machine
 * limits — CPU/RAM come from the global `%USERPROFILE%\.wslconfig` and the disk
 * is a dynamically-growing VHDX with no ceiling. The cap is still passed: it is
 * correct for the Hyper-V provider and it keeps one Resource Cap as the single
 * source of truth for both engines.
 */
export function podmanMachineInitArgs(cap: ResourceCap = RESOURCE_CAP): string[] {
  return [
    "machine",
    "init",
    "--cpus",
    String(cap.cpu),
    "--memory",
    String(cap.memoryGiB * MIB_PER_GIB),
    "--disk-size",
    String(cap.diskGiB),
    ENGINE_PROFILE,
  ];
}

export function podmanMachineStartArgs(): string[] {
  return ["machine", "start", ENGINE_PROFILE];
}

/**
 * `--format` makes podman print the state alone, so nothing here parses its
 * JSON. A missing machine still exits non-zero — the format only shapes the
 * output of a successful inspect — so this doubles as an existence probe.
 */
export function podmanMachineInspectArgs(): string[] {
  return ["machine", "inspect", "--format", "{{.State}}", ENGINE_PROFILE];
}

/**
 * Rootful, applied once at init time. boxRunArgs passes `--cap-add NET_ADMIN`
 * plus two `net.ipv6.*` sysctls, which rootless podman rejects, and rootless
 * pasta/slirp4netns move the gateway and resolver `apply-egress.sh` discovers.
 * Rootless buys nothing here: the boundary is the container (ADR 0001) and the
 * machine is already a VM.
 */
export function podmanMachineSetRootfulArgs(): string[] {
  return ["machine", "set", "--rootful", ENGINE_PROFILE];
}
