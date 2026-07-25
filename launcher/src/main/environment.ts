import { BOX_CONTAINER, BOX_IMAGE, ENGINE_CLI } from "../core/config";
import type { BoxState } from "../core/startup";
import { isEngineRunning } from "./engine";
import { run } from "./exec";

/**
 * Inspect the live host to build the BoxState that startupPlan() consumes.
 * Isolated here so the decision logic (core/startup.ts) stays pure and testable.
 */
export async function inspectBoxState(): Promise<BoxState> {
  // BoxState still calls this `colimaRunning`; on Windows the engine is a Podman
  // machine (issue #10), which is why the query lives behind main/engine.ts.
  const colimaRunning = await isEngineRunning();

  // If the VM isn't up, the engine can't be queried; treat image/container as absent.
  if (!colimaRunning) {
    return { colimaRunning: false, imageBuilt: false, containerExists: false, containerRunning: false };
  }

  const images = await run(ENGINE_CLI, ["images", "-q", BOX_IMAGE]);
  const imageBuilt = images.stdout.trim().length > 0;

  const nameFilter = ["--filter", `name=^${BOX_CONTAINER}$`, "--format", "{{.Names}}"];
  const running = await run(ENGINE_CLI, ["ps", ...nameFilter]);
  const all = await run(ENGINE_CLI, ["ps", "-a", ...nameFilter]);

  return {
    colimaRunning,
    imageBuilt,
    containerExists: all.stdout.trim() === BOX_CONTAINER,
    containerRunning: running.stdout.trim() === BOX_CONTAINER,
  };
}
