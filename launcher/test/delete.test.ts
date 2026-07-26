import { describe, expect, it } from "vitest";
import {
  assertDeletableProjectPath,
  confirmsProjectName,
  parseProjectUsage,
} from "../src/core/delete";

describe("assertDeletableProjectPath", () => {
  it("builds the Project's path under the Workspace", () => {
    expect(assertDeletableProjectPath("/workspace", "my-site")).toBe("/workspace/my-site");
  });

  it("refuses a traversal rather than resolving it", () => {
    expect(() => assertDeletableProjectPath("/workspace", "..")).toThrow(/unsafe/i);
    expect(() => assertDeletableProjectPath("/workspace", "../..")).toThrow(/unsafe/i);
    expect(() => assertDeletableProjectPath("/workspace", "a/../..")).toThrow(/unsafe/i);
  });

  it("can never be handed the Workspace root itself — the rm -rf that would empty it", () => {
    expect(() => assertDeletableProjectPath("/workspace", "")).toThrow();
    expect(() => assertDeletableProjectPath("/workspace", ".")).toThrow();
    expect(() => assertDeletableProjectPath("/workspace", "/")).toThrow();
  });

  it("refuses a slug that would inject into the Box-side command", () => {
    expect(() => assertDeletableProjectPath("/workspace", "a; rm -rf /")).toThrow(/unsafe/i);
    expect(() => assertDeletableProjectPath("/workspace", "a b")).toThrow(/unsafe/i);
    expect(() => assertDeletableProjectPath("/workspace", "$(whoami)")).toThrow(/unsafe/i);
  });

  it("stays a POSIX Box path on a Windows host (node:path would make it C:\\workspace)", () => {
    // The Launcher runs on Windows too (ADR 0004); the path it deletes is inside
    // the Box either way, so it must never pick up a host path separator.
    expect(assertDeletableProjectPath("/workspace", "my-site")).not.toContain("\\");
  });
});

describe("confirmsProjectName", () => {
  it("accepts the name as shown", () => {
    expect(confirmsProjectName("My website", "My website")).toBe(true);
  });

  it("forgives case and stray whitespace — the typing is intent, not a spelling test", () => {
    expect(confirmsProjectName("  my WEBSITE ", "My website")).toBe(true);
    expect(confirmsProjectName("my  website", "My website")).toBe(true);
  });

  it("rejects a near miss", () => {
    expect(confirmsProjectName("My websit", "My website")).toBe(false);
    expect(confirmsProjectName("My website 2", "My website")).toBe(false);
  });

  it("rejects an empty field, which is what a misclick leaves behind", () => {
    expect(confirmsProjectName("", "My website")).toBe(false);
    expect(confirmsProjectName("   ", "My website")).toBe(false);
  });

  it("cannot be satisfied by an empty field even if the Project's name is blank", () => {
    expect(confirmsProjectName("", "")).toBe(false);
    expect(confirmsProjectName("  ", "   ")).toBe(false);
  });
});

describe("parseProjectUsage", () => {
  it("reads the file count and converts du's KiB to bytes", () => {
    expect(parseProjectUsage("42\n2048\n")).toEqual({ fileCount: 42, totalBytes: 2048 * 1024 });
  });

  it("reads an empty Project as genuinely empty", () => {
    expect(parseProjectUsage("0\n0\n")).toEqual({ fileCount: 0, totalBytes: 0 });
  });

  it("tolerates the whitespace `wc -l` pads its count with", () => {
    expect(parseProjectUsage("     7\n  120\n")).toEqual({ fileCount: 7, totalBytes: 120 * 1024 });
  });

  it("gives up rather than guessing zero — the sheet must be able to say so", () => {
    expect(parseProjectUsage("")).toBeUndefined();
    expect(parseProjectUsage("42\n")).toBeUndefined();
    expect(parseProjectUsage("du: cannot read\n")).toBeUndefined();
    expect(parseProjectUsage("nope\nnope\n")).toBeUndefined();
    expect(parseProjectUsage("-1\n10\n")).toBeUndefined();
    expect(parseProjectUsage("1.5\n10\n")).toBeUndefined();
  });
});
