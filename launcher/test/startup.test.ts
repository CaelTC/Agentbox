import { describe, expect, it } from "vitest";
import { startupPlan, stepMessage, type BoxState } from "../src/core/startup";

const state = (over: Partial<BoxState> = {}): BoxState => ({
  engineRunning: false,
  imageBuilt: false,
  containerExists: false,
  containerRunning: false,
  ...over,
});

describe("startupPlan", () => {
  it("from cold: start the Engine, build the image, run the Box, then attach — in order", () => {
    expect(startupPlan(state())).toEqual([
      "start-engine",
      "build-image",
      "run-box",
      "attach",
    ]);
  });

  it("when everything is already up, just attach (fast reopen — ticket 04 AC)", () => {
    expect(
      startupPlan(
        state({ engineRunning: true, imageBuilt: true, containerExists: true, containerRunning: true }),
      ),
    ).toEqual(["attach"]);
  });

  it("skips the Engine start when the Engine is already running", () => {
    const plan = startupPlan(state({ engineRunning: true }));
    expect(plan).not.toContain("start-engine");
    expect(plan[0]).toBe("build-image");
  });

  it("restarts an EXISTING stopped container instead of rebuilding (preserves login)", () => {
    const plan = startupPlan(
      state({ engineRunning: true, imageBuilt: true, containerExists: true }),
    );
    expect(plan).toEqual(["start-box", "attach"]);
    expect(plan).not.toContain("run-box");
    expect(plan).not.toContain("build-image");
  });

  it("runs a fresh Box when the image exists but no container does", () => {
    const plan = startupPlan(state({ engineRunning: true, imageBuilt: true }));
    expect(plan).toEqual(["run-box", "attach"]);
  });

  it("always ends by attaching a session", () => {
    expect(startupPlan(state()).at(-1)).toBe("attach");
    expect(
      startupPlan(state({ containerExists: true, containerRunning: true })).at(-1),
    ).toBe("attach");
  });

  it("if the container is running, no rebuild and no restart", () => {
    const plan = startupPlan(
      state({ engineRunning: true, containerExists: true, containerRunning: true }),
    );
    expect(plan).not.toContain("build-image");
    expect(plan).not.toContain("run-box");
    expect(plan).not.toContain("start-box");
  });
});

/**
 * The starting screen's sub-line. Every step that makes the Sandbox User WAIT
 * has to name itself, because a motionless screen and a hung Launcher look the
 * same (issue #27); `attach` is the plan's terminator rather than work, so it is
 * the one step with nothing to say.
 */
describe("stepMessage", () => {
  it("names every step that costs the Sandbox User a wait", () => {
    for (const step of ["start-engine", "build-image", "run-box", "start-box"] as const) {
      expect(stepMessage(step)).toBeTruthy();
    }
  });

  it("says nothing for attach — it is the end of the plan, not a wait", () => {
    expect(stepMessage("attach")).toBeUndefined();
  });

  it("calls the long one a build, since that is the wait people ask about", () => {
    expect(stepMessage("build-image")).toMatch(/building/i);
  });
});
