/**
 * Startup orchestration (ticket 04). Given what's already running, decide the
 * minimal ordered set of steps to get the Sandbox User into a working session.
 * Pure so the "fast reopen returns to a working session" behaviour is testable
 * without a live Engine.
 */
export interface BoxState {
  engineRunning: boolean;
  imageBuilt: boolean;
  /** A container named `agentbox` exists (running OR stopped). */
  containerExists: boolean;
  /** That container is currently running. */
  containerRunning: boolean;
}

export type StartupStep = "start-engine" | "build-image" | "run-box" | "start-box" | "attach";

/**
 * How a slow step announces itself while it runs. Optional everywhere it is
 * threaded, so a caller that has no screen to draw on — every test, and
 * `updateAgentbox` — passes nothing and is unchanged.
 */
export type OnStep = (message: string) => void;

/**
 * What the starting screen says while a step runs. Plain machinery, in the
 * Launcher's own words: the Sandbox User cannot act on any of it, but the person
 * who set the machine up reads this screen over their shoulder, and "something
 * is happening" is worth less than "it is building".
 *
 * `attach` has nothing to say — it is the plan's terminator, not work — so it
 * returns undefined rather than an empty line the caller has to remember to skip.
 */
const STEP_MESSAGES: Record<StartupStep, string | undefined> = {
  "start-engine": "Starting the engine…",
  "build-image": "Building the image…",
  "run-box": "Starting the container…",
  "start-box": "Starting the container…",
  attach: undefined,
};

export function stepMessage(step: StartupStep): string | undefined {
  return STEP_MESSAGES[step];
}

export function startupPlan(state: BoxState): StartupStep[] {
  const steps: StartupStep[] = [];

  if (!state.engineRunning) {
    steps.push("start-engine");
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
