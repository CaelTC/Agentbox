import { engineCli } from "../core/config";
import { colimaStartArgs, colimaStatusArgs, isColimaRunning } from "../core/colima";
import {
  podmanMachineInitArgs,
  podmanMachineInspectArgs,
  podmanMachineSetRootfulArgs,
  podmanMachineStartArgs,
} from "../core/podman";
import { mustSucceed, run, runOk } from "./exec";

/**
 * The engine seam (issue #10): the Box's VM is Colima on the Mac and a Podman
 * machine on Windows. Both engines sit behind these two calls, so core/startup.ts
 * keeps one platform-neutral "start the engine" step and its plan logic — the
 * tested part — is untouched.
 *
 * `platform` is a defaulted parameter so the Windows argv is assertable from a Mac.
 */

/** Is the Box's VM up? Nothing else can be queried until it is. */
export async function isEngineRunning(
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  if (platform === "win32") {
    const inspect = await run(engineCli(platform), podmanMachineInspectArgs());
    return inspect.code === 0 && inspect.stdout.trim() === "running";
  }
  const status = await run("colima", colimaStatusArgs());
  return isColimaRunning(status.stdout + status.stderr);
}

/**
 * Start the Box's VM at the Resource Cap.
 *
 * `colima start` is create-or-start in one command; `podman machine` splits
 * `init` from `start` — the only place the two engines aren't shaped alike.
 * Resolved here, in the runner, rather than in the startup plan: the Launcher
 * then still self-heals if someone deletes the VM, and BoxState/StartupStep stay
 * as they are. Rootful is re-applied on every start, not once at init (see below).
 */
export async function startEngine(platform: NodeJS.Platform = process.platform): Promise<void> {
  if (platform !== "win32") {
    await mustSucceed("colima", colimaStartArgs());
    return;
  }

  const engine = engineCli(platform);
  // `machine inspect` exits non-zero when there is no such machine, so absence
  // is an exit code, not a parse.
  if (!(await runOk(engine, podmanMachineInspectArgs()))) {
    await mustSucceed(engine, podmanMachineInitArgs());
  }
  // Outside the init branch on purpose. If `init` succeeded and this failed,
  // pinning it to that branch would skip it on every later run: the machine
  // exists, so init is never reached again, and the Box runs rootless forever —
  // self-healing only by deleting the VM. Re-applying is a no-op when it is
  // already set, and it is safe here because the caller only starts an engine
  // that isEngineRunning said was down (podman refuses the change on a live one).
  await mustSucceed(engine, podmanMachineSetRootfulArgs());
  await mustSucceed(engine, podmanMachineStartArgs());
}
