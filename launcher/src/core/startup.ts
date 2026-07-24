/**
 * Startup orchestration (ticket 04). Given what's already running, decide the
 * minimal ordered set of steps to get the Sandbox User into a working session.
 * Pure so the "fast reopen returns to a working session" behaviour is testable
 * without a live Colima.
 */
export interface BoxState {
  colimaRunning: boolean;
  imageBuilt: boolean;
  /** A container named `claudebox` exists (running OR stopped). */
  containerExists: boolean;
  /** That container is currently running. */
  containerRunning: boolean;
}

export type StartupStep = "start-colima" | "build-image" | "run-box" | "start-box" | "attach";

export function startupPlan(state: BoxState): StartupStep[] {
  const steps: StartupStep[] = [];

  if (!state.colimaRunning) {
    steps.push("start-colima");
  }

  if (!state.containerRunning) {
    if (state.containerExists) {
      // Restart the EXISTING container so its filesystem — including the
      // Login-with-Claude session — survives across restarts (ticket 01).
      steps.push("start-box");
    } else {
      if (!state.imageBuilt) {
        steps.push("build-image");
      }
      steps.push("run-box");
    }
  }

  steps.push("attach");
  return steps;
}
