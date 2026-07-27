import { colima } from "./colima";
import { podman } from "./podman";

/**
 * The Engine seam (issue #10): the Box's VM is Colima on the Mac and a Podman
 * machine on Windows. Both runtimes implement this interface, so every caller
 * outside the two adapters holds an Engine and never learns which one it is —
 * core/startup.ts keeps one platform-neutral "start the engine" step and its
 * plan logic, the tested part, is untouched.
 *
 * Two operations, because that is all the Launcher ever asks of the VM.
 */
export interface Engine {
  /** Is the Box's VM up? Nothing else can be queried until it is. */
  isRunning(): Promise<boolean>;
  /** Bring the VM up at the Resource Cap, creating it first if it does not exist. */
  start(): Promise<void>;
}

/**
 * The Engine for a host. `platform` is a defaulted parameter so the Windows
 * Engine — and the argv it spawns — stays assertable from a Mac.
 */
export function engineFor(platform: NodeJS.Platform = process.platform): Engine {
  return platform === "win32" ? podman : colima;
}

/** This host's Engine. */
export const engine: Engine = engineFor();
