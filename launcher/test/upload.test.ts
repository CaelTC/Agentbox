import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { performUpload, resolveUploadTargets } from "../src/core/upload";

let project: string;
let host: string;
beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "claudebox-proj-"));
  host = mkdtempSync(join(tmpdir(), "host-files-"));
});

const hostFile = (name: string, body = "data") => {
  const p = join(host, name);
  writeFileSync(p, body);
  return p;
};

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

describe("performUpload", () => {
  it("copies host files into the Project so Claude can read them", () => {
    const src = hostFile("data.csv", "a,b,c\n1,2,3\n");
    const results = performUpload([src], project);
    expect(results[0]!.dest).toBe(join(project, "data.csv"));
    expect(existsSync(join(project, "data.csv"))).toBe(true);
    expect(readFileSync(join(project, "data.csv"), "utf8")).toBe("a,b,c\n1,2,3\n");
  });

  it("is a ONE-WAY copy: later changes to the host file do not reach the Box", () => {
    const src = hostFile("live.txt", "v1");
    performUpload([src], project);
    appendFileSync(src, "-v2"); // host file mutates after upload
    expect(readFileSync(join(project, "live.txt"), "utf8")).toBe("v1");
  });
});
