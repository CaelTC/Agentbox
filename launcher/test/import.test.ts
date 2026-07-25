import { describe, expect, it } from "vitest";
import {
  IMPORT_SEED_PROMPT,
  IMPORT_SIZE_WARNING_BYTES,
  assertRepoRelativePaths,
  deriveImportIdentity,
  importTarArgs,
  importTarInput,
  isRepoRelativePath,
  parseDfAvailableBytes,
  parseGitLsFiles,
  planImport,
  type ImportFile,
} from "../src/core/import";

describe("parseGitLsFiles", () => {
  it("splits git ls-files -z's NUL-separated output into paths", () => {
    expect(parseGitLsFiles("README.md\0src/index.ts\0")).toEqual(["README.md", "src/index.ts"]);
  });

  it("drops the spurious trailing empty entry after the last NUL", () => {
    expect(parseGitLsFiles("a\0b\0")).toEqual(["a", "b"]);
  });

  it("returns nothing for an empty repo listing", () => {
    expect(parseGitLsFiles("")).toEqual([]);
  });

  it("keeps a path that itself contains no separators", () => {
    expect(parseGitLsFiles("notes.md\0")).toEqual(["notes.md"]);
  });
});

describe("isRepoRelativePath", () => {
  it("accepts ordinary relative paths, however deep", () => {
    for (const p of ["notes.md", "src/index.ts", "a/b/c/d.txt", ".gitignore", ".git/config"]) {
      expect(isRepoRelativePath(p), p).toBe(true);
    }
  });

  it("refuses an absolute path", () => {
    expect(isRepoRelativePath("/etc/passwd")).toBe(false);
  });

  it("refuses any path that climbs out with ..", () => {
    expect(isRepoRelativePath("../outside")).toBe(false);
    expect(isRepoRelativePath("a/../../outside")).toBe(false);
    expect(isRepoRelativePath("a/..")).toBe(false);
  });

  it("refuses an empty path or one with an empty segment", () => {
    expect(isRepoRelativePath("")).toBe(false);
    expect(isRepoRelativePath("a//b")).toBe(false);
  });

  it("refuses a lone '.' segment", () => {
    expect(isRepoRelativePath("./a")).toBe(false);
  });
});

describe("assertRepoRelativePaths", () => {
  it("returns the list unchanged when every path is safe", () => {
    const paths = ["a.md", "src/b.ts"];
    expect(assertRepoRelativePaths(paths)).toEqual(paths);
  });

  it("throws naming the offending path, before anything reaches tar", () => {
    expect(() => assertRepoRelativePaths(["ok.md", "../../etc/passwd"])).toThrow(
      /\.\.\/\.\.\/etc\/passwd/,
    );
  });

  it("throws on an absolute path even alongside otherwise-safe ones", () => {
    expect(() => assertRepoRelativePaths(["a.md", "/etc/passwd"])).toThrow();
  });
});

describe("importTarArgs", () => {
  it("passes -c, so tar actually creates an archive", () => {
    // This shipped once without -c: tar wrote zero bytes, `docker cp -` took the
    // empty stream and exited 0, and every import silently copied nothing.
    expect(importTarArgs("/tmp/proj", true)).toContain("-c");
  });

  it("reads the file list from stdin, NUL-separated, rooted at the folder", () => {
    const args = importTarArgs("/tmp/proj", false);
    expect(args.slice(-5)).toEqual(["-C", "/tmp/proj", "--null", "-T", "-"]);
  });

  // Each of these was live-reproduced against a real Box; see the comment on
  // importTarArgs for what breaks when the flag is missing.
  it("suppresses macOS xattrs, which Linux overlayfs refuses and docker cp dies on", () => {
    expect(importTarArgs("/tmp/proj", true)).toContain("--no-xattrs");
  });

  it("suppresses AppleDouble sidecars, so no ._file junk lands in the Project", () => {
    expect(importTarArgs("/tmp/proj", true)).toContain("--no-mac-metadata");
  });

  it("does not set ownership here — docker cp synthesises parent dirs as root regardless, so boxImportFolder chowns instead", () => {
    expect(importTarArgs("/tmp/proj", true)).not.toContain("--uid");
  });

  it("adds .git as an extra positional path for a repo, since git ls-files never lists it", () => {
    expect(importTarArgs("/tmp/proj", true).at(-1)).toBe(".git");
  });

  it("leaves .git out for a plain folder, which has none", () => {
    expect(importTarArgs("/tmp/proj", false)).not.toContain(".git");
  });
});

describe("importTarInput", () => {
  it("NUL-separates and NUL-terminates, as tar --null -T - expects", () => {
    expect(importTarInput(["a.md", "src/b.ts"])).toBe("a.md\0src/b.ts\0");
  });

  it("writes nothing for an empty list, rather than a lone NUL tar reads as an empty path", () => {
    expect(importTarInput([])).toBe("");
  });

  it("round-trips through parseGitLsFiles", () => {
    const paths = ["a.md", "src/b.ts", "deep/nested/c.txt"];
    expect(parseGitLsFiles(importTarInput(paths))).toEqual(paths);
  });
});

describe("deriveImportIdentity", () => {
  it("derives a slug from the folder name, keeping the name readable", () => {
    expect(deriveImportIdentity("My Cool App", [])).toEqual({
      name: "My Cool App",
      slug: "my-cool-app",
    });
  });

  it("auto-suffixes -2 on a slug collision, matching resolveUploadTargets, rather than throwing", () => {
    expect(deriveImportIdentity("demo", ["demo"])).toEqual({ name: "demo", slug: "demo-2" });
  });

  it("keeps suffixing past -2 through repeated collisions", () => {
    expect(deriveImportIdentity("demo", ["demo", "demo-2", "demo-3"])).toEqual({
      name: "demo",
      slug: "demo-4",
    });
  });

  it("falls back to a generic slug when the folder name reduces to nothing (CJK, symbols-only)", () => {
    const cjk = deriveImportIdentity("プロジェクト", []);
    expect(cjk.slug).toBe("project");
    expect(cjk.name).toBe("プロジェクト"); // the friendly name still keeps the original text

    const symbols = deriveImportIdentity("!!!", []);
    expect(symbols.slug).toBe("project");
  });

  it("suffixes the fallback slug too, when it collides", () => {
    expect(deriveImportIdentity("プロジェクト", ["project"])).toEqual({
      name: "プロジェクト",
      slug: "project-2",
    });
  });

  it("falls back the name to the slug when the folder name is only whitespace", () => {
    expect(deriveImportIdentity("   ", [])).toEqual({ name: "project", slug: "project" });
  });
});

describe("planImport", () => {
  const file = (path: string, size: number): ImportFile => ({ path, size });

  it("sums every file's size, regardless of the warning threshold", () => {
    const plan = planImport([file("a", 10), file("b", 20)], 1_000_000);
    expect(plan.fileCount).toBe(2);
    expect(plan.totalBytes).toBe(30);
    expect(plan.overWarnThreshold).toBe(false);
    expect(plan.fitsFreeSpace).toBe(true);
  });

  it("flags totals over the ~2 GB warning threshold without refusing them", () => {
    const plan = planImport([file("huge.bin", IMPORT_SIZE_WARNING_BYTES + 1)], Number.MAX_SAFE_INTEGER);
    expect(plan.overWarnThreshold).toBe(true);
    expect(plan.warnBytes).toBe(IMPORT_SIZE_WARNING_BYTES);
    expect(plan.fitsFreeSpace).toBe(true); // big is fine as long as it fits
  });

  it("refuses when the total exceeds the Box's free space", () => {
    const plan = planImport([file("a", 100)], 50);
    expect(plan.fitsFreeSpace).toBe(false);
    expect(plan.totalBytes).toBe(100);
    expect(plan.freeBytes).toBe(50);
  });

  it("fits exactly at the free-space boundary", () => {
    const plan = planImport([file("a", 100)], 100);
    expect(plan.fitsFreeSpace).toBe(true);
  });

  it("reports zero for an empty file list", () => {
    const plan = planImport([], 100);
    expect(plan.fileCount).toBe(0);
    expect(plan.totalBytes).toBe(0);
    expect(plan.fitsFreeSpace).toBe(true);
  });
});

describe("parseDfAvailableBytes", () => {
  it("reads the Available column (in KB) from df -k's output", () => {
    const stdout = [
      "Filesystem     1K-blocks     Used Available Use% Mounted on",
      "overlay        25165824 10000000  15165824  40% /workspace",
    ].join("\n");
    expect(parseDfAvailableBytes(stdout)).toBe(15165824 * 1024);
  });

  it("tolerates extra whitespace between columns", () => {
    const stdout = "Filesystem  1K-blocks  Used  Available  Use%  Mounted\n" + "overlay   100   10   90   10%   /workspace";
    expect(parseDfAvailableBytes(stdout)).toBe(90 * 1024);
  });

  it("throws rather than guessing when the output doesn't parse", () => {
    expect(() => parseDfAvailableBytes("not df output")).toThrow(/free space/i);
    expect(() => parseDfAvailableBytes("")).toThrow();
  });
});

describe("IMPORT_SEED_PROMPT", () => {
  it("is the fixed orientation prompt, so an Import never opens on a blank chat", () => {
    // Neutral, not "my Mac": this is model-facing text on a Launcher that ships
    // to Windows too (#12).
    expect(IMPORT_SEED_PROMPT).toMatch(/brought this project in from my computer/i);
    expect(IMPORT_SEED_PROMPT).not.toMatch(/mac/i);
    expect(IMPORT_SEED_PROMPT).toMatch(/what it is/i);
  });
});
