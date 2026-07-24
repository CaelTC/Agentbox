import { BOX_CONTAINER, BOX_IMAGE, COLIMA_PROFILE } from "../core/config";
import { colimaStatusArgs, isColimaRunning } from "../core/colima";
import type { BoxState } from "../core/startup";
import { run } from "./exec";

/**
 * Inspect the live host to build the BoxState that startupPlan() consumes.
 * Isolated here so the decision logic (core/startup.ts) stays pure and testable.
 */
export async function inspectBoxState(): Promise<BoxState> {
  const colima = await run("colima", colimaStatusArgs(COLIMA_PROFILE));
  const colimaRunning = isColimaRunning(colima.stdout + colima.stderr);

  // If Colima isn't up, docker can't be queried; treat image/container as absent.
  if (!colimaRunning) {
    return { colimaRunning: false, imageBuilt: false, containerExists: false, containerRunning: false };
  }

  const images = await run("docker", ["images", "-q", BOX_IMAGE]);
  const imageBuilt = images.stdout.trim().length > 0;

  const nameFilter = ["--filter", `name=^${BOX_CONTAINER}$`, "--format", "{{.Names}}"];
  const running = await run("docker", ["ps", ...nameFilter]);
  const all = await run("docker", ["ps", "-a", ...nameFilter]);

  return {
    colimaRunning,
    imageBuilt,
    containerExists: all.stdout.trim() === BOX_CONTAINER,
    containerRunning: running.stdout.trim() === BOX_CONTAINER,
  };
}
