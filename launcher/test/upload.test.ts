import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { resolveUploadTargets } from "../src/core/upload";

let project: string;
let host: string;
beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "agentbox-proj-"));
  host = mkdtempSync(join(tmpdir(), "host-files-"));
});

describe("resolveUploadTargets", () => {
  it("copies each file to the Project by its basename", () => {
    const targets = resolveUploadTargets([join(host, "budget.csv")], project);
    expect(targets).toEqual([
      { source: join(host, "budget.csv"), dest: join(project, "budget.csv") },
    ]);
  });

  it("keeps destinations strictly inside the Project (no traversal from a crafted path)", () => {
    const targets = resolveUploadTargets(["/etc/passwd", "../../secret"], project);
    for (const t of targets) {
      expect(t.dest.startsWith(project)).toBe(true);
      expect(t.dest).not.toContain("..");
    }
  });

  it("disambiguates colliding names within one batch", () => {
    const targets = resolveUploadTargets(
      [join(host, "a", "notes.txt"), join(host, "b", "notes.txt")],
      project,
    );
    const dests = targets.map((t) => t.dest);
    expect(new Set(dests).size).toBe(2);
    expect(dests[0]).toBe(join(project, "notes.txt"));
    expect(dests[1]).toBe(join(project, "notes-2.txt"));
  });

  it("disambiguates against files already in the Project", () => {
    writeFileSync(join(project, "report.pdf"), "existing");
    const [t] = resolveUploadTargets([join(host, "report.pdf")], project);
    expect(t!.dest).toBe(join(project, "report-2.pdf"));
  });

  it("uses an injected existence check (for a Box-backed Workspace with no host mirror)", () => {
    const boxFiles = new Set([join("/workspace/demo", "data.csv")]);
    const [t] = resolveUploadTargets([join(host, "data.csv")], "/workspace/demo", {
      exists: (p) => boxFiles.has(p),
    });
    expect(t!.dest).toBe(join("/workspace/demo", "data-2.csv"));
  });
});
