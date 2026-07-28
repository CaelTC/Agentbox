import { ENGINE_PROFILE, RESOURCE_CAP, type ResourceCap } from "../core/config";
import type { Engine } from "./engine";
import { mustSucceed, run } from "./exec";

/**
 * The Colima adapter: the Box's VM on the Mac. Every Colima-shaped quirk lives
 * here, behind the Engine interface.
 */

/**
 * Build the `colima` CLI args that start the Box's VM at the Resource Cap.
 * The Launcher owns this so the Sandbox User never types a Colima command
 * (ticket 04) and can never exceed the tuned allocation (ticket 01 / CONTEXT.md).
 */
export function colimaStartArgs(
  cap: ResourceCap = RESOURCE_CAP,
  profile: string = ENGINE_PROFILE,
): string[] {
  return [
    "start",
    "--profile",
    profile,
    "--cpu",
    String(cap.cpu),
    "--memory",
    String(cap.memoryGiB),
    "--disk",
    String(cap.diskGiB),
  ];
}

export function colimaStatusArgs(profile: string = ENGINE_PROFILE): string[] {
  return ["status", "--profile", profile];
}

/**
 * Colima prints "... is running" on the status stream when the VM is up. With a
 * named profile the line is `colima [profile=agentbox] is running`, so match on
 * "is running" rather than "colima is running" — and NOT the "is not running"
 * that colima prints when down.
 */
export function isColimaRunning(statusOutput: string): boolean {
  return /\bis running\b/i.test(statusOutput);
}

export const colima: Engine = {
  /** Colima reports state as prose, and on stderr — hence the parse over both streams. */
  async isRunning(): Promise<boolean> {
    const status = await run("colima", colimaStatusArgs());
    return isColimaRunning(status.stdout + status.stderr);
  },

  /** `colima start` is create-or-start in one command, so there is nothing else to do. */
  async start(): Promise<void> {
    await mustSucceed("colima", colimaStartArgs());
  },
};
