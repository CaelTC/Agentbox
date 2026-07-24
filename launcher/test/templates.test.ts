import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { projectSeedPrompt } from "../src/core/projects";
import {
  STARTER_TEMPLATES,
  instantiateTemplate,
  templateById,
} from "../src/core/templates";

let ws: string;
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "claudebox-ws-"));
});

describe("STARTER_TEMPLATES", () => {
  it("offers the three canonical starting points (CONTEXT.md)", () => {
    const ids = STARTER_TEMPLATES.map((t) => t.id).sort();
    expect(ids).toEqual(["analyze-spreadsheet", "guessing-game", "personal-webpage"]);
  });

  it("gives every template a title and a non-empty seed prompt", () => {
    for (const t of STARTER_TEMPLATES) {
      expect(t.title.length).toBeGreaterThan(0);
      expect(t.seedPrompt.trim().length).toBeGreaterThan(0);
    }
  });

  it("the spreadsheet template signals it wants Upload; the webpage wants Preview", () => {
    expect(templateById("analyze-spreadsheet")!.needs).toContain("upload");
    expect(templateById("personal-webpage")!.needs).toContain("preview");
  });
});

describe("templateById", () => {
  it("returns undefined for an unknown id", () => {
    expect(templateById("nope")).toBeUndefined();
  });
});

describe("instantiateTemplate", () => {
  it("creates a new Project and seeds its first prompt", () => {
    const { project, seedPrompt } = instantiateTemplate(ws, "guessing-game");
    expect(existsSync(project.dir)).toBe(true);
    expect(seedPrompt).toBe(templateById("guessing-game")!.seedPrompt);
    // the seeded prompt is persisted so a resumed session can recover it
    expect(projectSeedPrompt(ws, project.slug)).toBe(seedPrompt);
  });

  it("honours a custom Project name", () => {
    const { project } = instantiateTemplate(ws, "personal-webpage", "About Me");
    expect(project.name).toBe("About Me");
    expect(project.slug).toBe("about-me");
  });

  it("throws for an unknown template id", () => {
    expect(() => instantiateTemplate(ws, "nope")).toThrow(/template/i);
  });
});
