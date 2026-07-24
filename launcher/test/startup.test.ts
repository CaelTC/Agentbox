import { describe, expect, it } from "vitest";
import { startupPlan, type BoxState } from "../src/core/startup";

const state = (over: Partial<BoxState> = {}): BoxState => ({
  colimaRunning: false,
  imageBuilt: false,
  containerExists: false,
  containerRunning: false,
  ...over,
});

describe("startupPlan", () => {
  it("from cold: start Colima, build the image, run the Box, then attach — in order", () => {
    expect(startupPlan(state())).toEqual([
      "start-colima",
      "build-image",
      "run-box",
      "attach",
    ]);
  });

  it("when everything is already up, just attach (fast reopen — ticket 04 AC)", () => {
    expect(
      startupPlan(
        state({ colimaRunning: true, imageBuilt: true, containerExists: true, containerRunning: true }),
      ),
    ).toEqual(["attach"]);
  });

  it("skips the Colima start when Colima is already running", () => {
    const plan = startupPlan(state({ colimaRunning: true }));
    expect(plan).not.toContain("start-colima");
    expect(plan[0]).toBe("build-image");
  });

  it("restarts an EXISTING stopped container instead of rebuilding (preserves login)", () => {
    const plan = startupPlan(
      state({ colimaRunning: true, imageBuilt: true, containerExists: true }),
    );
    expect(plan).toEqual(["start-box", "attach"]);
    expect(plan).not.toContain("run-box");
    expect(plan).not.toContain("build-image");
  });

  it("runs a fresh Box when the image exists but no container does", () => {
    const plan = startupPlan(state({ colimaRunning: true, imageBuilt: true }));
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
      state({ colimaRunning: true, containerExists: true, containerRunning: true }),
    );
    expect(plan).not.toContain("build-image");
    expect(plan).not.toContain("run-box");
    expect(plan).not.toContain("start-box");
  });
});
