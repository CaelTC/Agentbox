import { describe, expect, it } from "vitest";
import { SLUG_RE, assertValidSlug, sanitizeProjectName } from "../src/core/projects";
import { repoFile } from "./repo-file";

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
  const boxFile = (...parts: string[]) => repoFile("box", ...parts);

  /**
   * The pattern of a `SLUG_RE = re.compile(r"…")` in a Python source file. Anchored
   * to the start of its line, so an unrelated `MY_SLUG_RE` elsewhere in the file
   * cannot be the thing this test reads while the real one drifts.
   */
  function pythonSlugPattern(source: string, where: string): string {
    const found = source.match(/^\s*_?SLUG_RE\s*=\s*re\.compile\(r"([^"]+)"\)/m);
    expect(found, `${where} no longer compiles a SLUG_RE`).not.toBeNull();
    return found![1];
  }

  /**
   * HOW the copy applies its pattern, which the pattern text cannot say. Python's
   * `$` matches just before a trailing newline as well as at the end of the
   * string, so `SLUG_RE.match("demo\n")` succeeds where the Launcher's identical
   * JavaScript pattern fails — the same regex, silently slacker on the Box side.
   * `fullmatch` is what makes the two agree.
   */
  function pythonSlugMatcher(source: string, where: string): string {
    const found = source.match(/^\s*(?:if not |return bool\()_?SLUG_RE\.(\w+)\(/m);
    expect(found, `${where} no longer applies its SLUG_RE`).not.toBeNull();
    return found![1];
  }

  it("box/bin/claudebox-session guards the slug with core/projects.ts's regex", () => {
    const source = boxFile("bin", "claudebox-session");
    expect(pythonSlugPattern(source, "claudebox-session")).toBe(SLUG_RE.source);
    expect(pythonSlugMatcher(source, "claudebox-session")).toBe("fullmatch");
  });

  it("box/terminal/paths.py rejects the same slugs core/projects.ts does", () => {
    const source = boxFile("terminal", "paths.py");
    expect(pythonSlugPattern(source, "paths.py")).toBe(SLUG_RE.source);
    expect(pythonSlugMatcher(source, "paths.py")).toBe("fullmatch");
  });

  it("rejects a trailing newline on every copy — the divergence `$` hides", () => {
    // Asserted from the JavaScript side here and from the Python side in
    // box/terminal/test_paths.py; the `fullmatch` checks above are what carry it
    // across to the two copies this file can only read as text.
    expect(SLUG_RE.test("demo\n")).toBe(false);
  });
});
