import { ENGINE_PROFILE, RESOURCE_CAP, type ResourceCap } from "../core/config";
import type { Engine } from "./engine";
import { mustSucceed, run } from "./exec";

/**
 * The Podman adapter: the Box's VM on Windows (issue #10), the counterpart of
 * main/colima.ts on the Mac. Every `podman machine` quirk lives here, behind the
 * Engine interface.
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
 * Rootful, re-applied on every start (see `start` below). boxRunArgs passes
 * `--cap-add NET_ADMIN` plus two `net.ipv6.*` sysctls, which rootless podman
 * rejects, and rootless pasta/slirp4netns move the gateway and resolver
 * `apply-egress.sh` discovers. Rootless buys nothing here: the boundary is the
 * container (ADR 0001) and the machine is already a VM.
 */
export function podmanMachineSetRootfulArgs(): string[] {
  return ["machine", "set", "--rootful", ENGINE_PROFILE];
}

const PODMAN = "podman";

export const podman: Engine = {
  /** Podman reports state as an exit code plus one exact word, so nothing is parsed. */
  async isRunning(): Promise<boolean> {
    const inspect = await run(PODMAN, podmanMachineInspectArgs());
    return inspect.code === 0 && inspect.stdout.trim() === "running";
  },

  /**
   * `colima start` is create-or-start in one command; `podman machine` splits
   * `init` from `start`. Resolved here, in the adapter, rather than in the
   * startup plan: the Launcher then still self-heals if someone deletes the VM,
   * and BoxState/StartupStep stay as they are.
   */
  async start(): Promise<void> {
    // `machine inspect` exits non-zero when there is no such machine, so absence
    // is an exit code, not a parse — the same read `isRunning` above does.
    if ((await run(PODMAN, podmanMachineInspectArgs())).code !== 0) {
      await mustSucceed(PODMAN, podmanMachineInitArgs());
    }
    // Outside the init branch on purpose. If `init` succeeded and this failed,
    // pinning it to that branch would skip it on every later run: the machine
    // exists, so init is never reached again, and the Box runs rootless forever —
    // self-healing only by deleting the VM. Re-applying is a no-op when it is
    // already set, and it is safe here because the caller only starts an engine
    // that isRunning() said was down (podman refuses the change on a live one).
    await mustSucceed(PODMAN, podmanMachineSetRootfulArgs());
    await mustSucceed(PODMAN, podmanMachineStartArgs());
  },
};
