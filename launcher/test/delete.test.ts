import { describe, expect, it } from "vitest";
import {
  assertDeletableProjectFilePath,
  assertDeletableProjectPath,
  confirmsProjectName,
  folderName,
  parseProjectUsage,
  planFileDelete,
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

/**
 * The trust boundary of deleting files. `relPath` arrives from the renderer, and
 * everything this returns is handed to a root `rm -rf` inside the Box — so the
 * question every case below asks is the same one: can a string get out of the
 * Project directory, or become the Project directory itself?
 */
describe("assertDeletableProjectFilePath", () => {
  const dir = "/workspace/my-site";

  it("builds the file's path under the Project", () => {
    expect(assertDeletableProjectFilePath(dir, "notes.md")).toBe("/workspace/my-site/notes.md");
    expect(assertDeletableProjectFilePath(dir, "data/2024/q1.csv")).toBe(
      "/workspace/my-site/data/2024/q1.csv",
    );
  });

  it("refuses a traversal rather than resolving it", () => {
    // The reason this is concatenation and not node:path: `normalize()` would
    // turn each of these into a real path OUTSIDE the Project and hand it over.
    for (const escape of [
      "..",
      "../other-project",
      "../../etc/passwd",
      "data/../../other-project",
      "data/../..",
      "a/./../../b",
    ]) {
      expect(() => assertDeletableProjectFilePath(dir, escape)).toThrow(/Refusing to delete/);
    }
  });

  it("refuses an absolute path — the one that ignores the Project entirely", () => {
    expect(() => assertDeletableProjectFilePath(dir, "/etc/passwd")).toThrow(/Refusing to delete/);
    expect(() => assertDeletableProjectFilePath(dir, "/workspace")).toThrow(/Refusing to delete/);
    expect(() => assertDeletableProjectFilePath(dir, "/")).toThrow(/Refusing to delete/);
  });

  it("can never be handed the Project directory itself — that has its own delete", () => {
    expect(() => assertDeletableProjectFilePath(dir, "")).toThrow(/Refusing to delete/);
    expect(() => assertDeletableProjectFilePath(dir, ".")).toThrow(/Refusing to delete/);
    expect(() => assertDeletableProjectFilePath(dir, "./")).toThrow(/Refusing to delete/);
  });

  it("refuses empty and doubled separators, which are a Project path in disguise", () => {
    expect(() => assertDeletableProjectFilePath(dir, "data//../..")).toThrow(/Refusing to delete/);
    expect(() => assertDeletableProjectFilePath(dir, "data/")).toThrow(/Refusing to delete/);
  });

  it("refuses anything hidden, which is what keeps .git and the marker undeletable", () => {
    expect(() => assertDeletableProjectFilePath(dir, ".git")).toThrow(/hidden/);
    expect(() => assertDeletableProjectFilePath(dir, ".git/config")).toThrow(/hidden/);
    expect(() => assertDeletableProjectFilePath(dir, ".agentbox/project.json")).toThrow(/hidden/);
    expect(() => assertDeletableProjectFilePath(dir, "src/.env")).toThrow(/hidden/);
  });

  it("stays a POSIX Box path on a Windows host (node:path would make it C:\\workspace)", () => {
    expect(assertDeletableProjectFilePath(dir, "data/costs.csv")).not.toContain("\\");
  });

  // Not sanitised, deliberately: `sh()` passes every path as a positional
  // argument, so it never meets the script text. What must hold is only that a
  // shell-ish name is contained — it is a legal filename, and refusing it would
  // leave a file no one can delete.
  it("keeps a shell-looking filename inside the Project", () => {
    expect(assertDeletableProjectFilePath(dir, "$(whoami).txt")).toBe(
      "/workspace/my-site/$(whoami).txt",
    );
    expect(assertDeletableProjectFilePath(dir, "a; rm -rf ~")).toBe("/workspace/my-site/a; rm -rf ~");
    expect(assertDeletableProjectFilePath(dir, "notes*.md")).toBe("/workspace/my-site/notes*.md");
  });
});

/**
 * The other half of the boundary: what the renderer ticked has to be something
 * the Box just listed. Membership is what makes an invented path unusable even
 * before containment is checked.
 */
describe("planFileDelete", () => {
  const files = [
    { path: "notes.md", size: 1_000, exportable: true },
    { path: "data/costs.csv", size: 2_000, exportable: true },
    { path: "data/2024/q1.csv", size: 4_000, exportable: true },
    { path: "data-old/costs.csv", size: 8_000, exportable: true },
  ];

  it("takes a listed file as itself", () => {
    const plan = planFileDelete(files, ["notes.md"]);
    expect(plan.targets).toEqual([{ path: "notes.md", folder: false, fileCount: 1, totalBytes: 1_000 }]);
    expect(plan.refused).toEqual([]);
    expect(plan).toMatchObject({ fileCount: 1, totalBytes: 1_000 });
  });

  it("takes a folder as everything under it, and nothing beside it", () => {
    const plan = planFileDelete(files, ["data"]);
    expect(plan.targets).toEqual([{ path: "data", folder: true, fileCount: 2, totalBytes: 6_000 }]);
    expect(plan.fileCount).toBe(2); // data-old/ is a sibling, not a child
  });

  it("refuses a path the Box's listing doesn't have, and names it", () => {
    const plan = planFileDelete(files, ["gone.md", "notes.md"]);
    expect(plan.targets.map((t) => t.path)).toEqual(["notes.md"]);
    expect(plan.refused).toEqual([{ path: "gone.md", reason: "It isn't in this project any more." }]);
  });

  // The pruned listing is the whole defence: `.git` is not in it, so no ticking
  // can produce a target under it — no second rule needed here.
  it("cannot produce a target the listing pruned", () => {
    expect(planFileDelete(files, [".git", ".git/config", "node_modules"]).targets).toEqual([]);
    expect(planFileDelete(files, ["..", "/etc/passwd"]).targets).toEqual([]);
  });

  it("counts a path ticked twice once", () => {
    expect(planFileDelete(files, ["notes.md", "notes.md"]).fileCount).toBe(1);
  });
});

describe("folderName", () => {
  it("is the last segment — the string the confirmation asks for", () => {
    expect(folderName("data/2024")).toBe("2024");
    expect(folderName("data")).toBe("data");
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
