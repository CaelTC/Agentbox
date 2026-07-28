import { describe, expect, it } from "vitest";
import { RESOURCE_CAP } from "../src/core/config";
import { colimaStartArgs, colimaStatusArgs, isColimaRunning } from "../src/main/colima";

describe("colimaStartArgs", () => {
  it("starts the agentbox profile at the Resource Cap (~4 CPU / 6 GB / 25 GB)", () => {
    const args = colimaStartArgs();
    expect(args).toEqual([
      "start",
      "--profile",
      "agentbox",
      "--cpu",
      "4",
      "--memory",
      "6",
      "--disk",
      "25",
    ]);
  });

  it("passes the Resource Cap through verbatim so the disk ceiling is honoured", () => {
    const args = colimaStartArgs({ cpu: 2, memoryGiB: 4, diskGiB: 10 });
    expect(args).toContain("--cpu");
    expect(args[args.indexOf("--cpu") + 1]).toBe("2");
    expect(args[args.indexOf("--disk") + 1]).toBe("10");
  });

  it("uses the real Resource Cap by default", () => {
    expect(RESOURCE_CAP).toEqual({ cpu: 4, memoryGiB: 6, diskGiB: 25 });
  });
});

describe("colimaStatusArgs", () => {
  it("queries the agentbox profile", () => {
    expect(colimaStatusArgs()).toEqual(["status", "--profile", "agentbox"]);
  });
});

describe("isColimaRunning", () => {
  it("is true when colima reports the profile running", () => {
    expect(isColimaRunning("colima is running")).toBe(true);
  });

  it("is true for the named-profile status line colima actually prints", () => {
    // Real output: `colima [profile=agentbox] is running`. The old
    // "colima is running" match missed this, so the Box was mis-built.
    expect(isColimaRunning('time="..." level=info msg="colima [profile=agentbox] is running"')).toBe(true);
  });

  it("is false when colima is not running", () => {
    expect(isColimaRunning("colima is not running")).toBe(false);
    expect(isColimaRunning("")).toBe(false);
  });
});
