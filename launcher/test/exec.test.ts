import { describe, expect, it } from "vitest";
import { spawnPath } from "../src/main/exec";

const allExist = () => true;
const noneExist = () => false;

describe("spawnPath", () => {
  it("prepends Homebrew bin so GUI-launched apps find colima", () => {
    const path = spawnPath("/usr/bin:/bin", allExist);
    expect(path.split(":")[0]).toBe("/opt/homebrew/bin");
    expect(path).toContain("/usr/bin");
  });

  it("leaves PATH unchanged when Homebrew is not installed", () => {
    expect(spawnPath("/usr/bin:/bin", noneExist)).toBe("/usr/bin:/bin");
  });

  it("does not duplicate a dir already on PATH", () => {
    const path = spawnPath("/opt/homebrew/bin:/usr/bin", allExist);
    expect(path.split(":").filter((d) => d === "/opt/homebrew/bin")).toHaveLength(1);
  });

  it("leaves PATH untouched on Windows — no Homebrew, and ':' is not the separator", () => {
    expect(spawnPath("C:\\Windows;C:\\podman", allExist, "win32")).toBe("C:\\Windows;C:\\podman");
  });
});
