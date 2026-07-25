import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EXPORT_CAP_BYTES,
  classifyBoxFile,
  exportFolderName,
  parseBoxFileListing,
  planExport,
  resolveExportDir,
  resolveExportTarget,
  type BoxFile,
} from "../src/core/export";
import { parseProjectMeta, serializeProjectMeta } from "../src/core/projects";

const file = (path: string, over: Partial<BoxFile> = {}): BoxFile => ({
  path,
  size: 100,
  executable: false,
  ...over,
});

const ROOT = "/Users/sandbox/Claudebox";

describe("classifyBoxFile", () => {
  it("passes documents and web files, so a webpage Project is useful when it lands", () => {
    for (const name of [
      "notes.md",
      "budget.csv",
      "report.pdf",
      "letter.docx",
      "index.html",
      "styles.css",
      "app.js",
      "photo.png",
      "logo.svg",
      "data.json",
    ]) {
      expect(classifyBoxFile(file(name)).exportable, name).toBe(true);
    }
  });

  it("refuses anything not document- or web-shaped", () => {
    const v = classifyBoxFile(file("analyse.py"));
    expect(v.exportable).toBe(false);
    expect(v.reason).toMatch(/documents and web files/i);
  });

  it("refuses files carrying the executable bit even when the name looks safe", () => {
    const v = classifyBoxFile(file("report.md", { executable: true }));
    expect(v.exportable).toBe(false);
    expect(v.reason).toMatch(/program/i);
  });

  it("refuses dotfiles and anything inside a dot-directory, so .git never crosses", () => {
    expect(classifyBoxFile(file(".env")).exportable).toBe(false);
    expect(classifyBoxFile(file(".git/config")).exportable).toBe(false);
    expect(classifyBoxFile(file(".claudebox/project.json")).exportable).toBe(false);
    expect(classifyBoxFile(file("docs/.hidden/notes.md")).exportable).toBe(false);
  });

  it("refuses node_modules", () => {
    const v = classifyBoxFile(file("node_modules/left-pad/readme.md"));
    expect(v.exportable).toBe(false);
    expect(v.reason).toMatch(/librar/i);
  });

  it("refuses paths that try to climb out of the Project", () => {
    expect(classifyBoxFile(file("../../etc/passwd")).exportable).toBe(false);
    expect(classifyBoxFile(file("/etc/passwd")).exportable).toBe(false);
    expect(classifyBoxFile(file("docs/../../secret.md")).exportable).toBe(false);
  });

  it("is case-insensitive about extensions", () => {
    expect(classifyBoxFile(file("REPORT.PDF")).exportable).toBe(true);
  });

  it("refuses a file with no extension", () => {
    expect(classifyBoxFile(file("Makefile")).exportable).toBe(false);
  });
});

describe("exportFolderName", () => {
  it("keeps the friendly name readable — spaces, capitals and accents survive", () => {
    expect(exportFolderName("My Café Notes", "my-cafe-notes")).toBe("My Café Notes");
  });

  it("strips path separators so a crafted name cannot become a directory hop", () => {
    expect(exportFolderName("../../etc", "evil")).not.toContain("..");
    expect(exportFolderName("a/b", "ab")).not.toContain("/");
    expect(exportFolderName("a\\b", "ab")).not.toContain("\\");
  });

  it("strips control characters and leading dots", () => {
    expect(exportFolderName("bad\u0000name\u001b", "bad")).toBe("badname");
    expect(exportFolderName("...hidden", "hidden")).toBe("hidden");
  });

  it("falls back to the slug when the name reduces to nothing", () => {
    expect(exportFolderName("../", "my-project")).toBe("my-project");
    expect(exportFolderName("   ", "my-project")).toBe("my-project");
  });
});

describe("resolveExportDir", () => {
  it("lands the Project under the export root using its friendly name", () => {
    expect(resolveExportDir(ROOT, { name: "My Report", slug: "my-report" })).toBe(
      join(ROOT, "My Report"),
    );
  });

  it("cannot write outside the export root even when the name comes straight from Box metadata", () => {
    // The friendly name is read from .claudebox/project.json INSIDE the Box, so
    // Claude can write it — it is untrusted input on the way to a host path.
    for (const hostile of ["../../../etc", "..", "/etc/passwd", "a/../../b", "\u0000/x"]) {
      const dir = resolveExportDir(ROOT, { name: hostile, slug: "safe-slug" });
      expect(dir.startsWith(ROOT + "/")).toBe(true);
      expect(dir).not.toContain("..");
    }
  });

  it("disambiguates by slug when two Projects' names sanitize alike", () => {
    const others = [{ name: "Report A", slug: "report-a" }];
    expect(resolveExportDir(ROOT, { name: "Report/A", slug: "report-a-2" }, others)).toBe(
      join(ROOT, "Report A (report-a-2)"),
    );
  });

  it("does not treat the Project itself as a clash", () => {
    const me = { name: "Solo", slug: "solo" };
    expect(resolveExportDir(ROOT, me, [me])).toBe(join(ROOT, "Solo"));
  });
});

describe("resolveExportTarget", () => {
  const dir = join(ROOT, "My Report");

  it("preserves the Project's folder structure so relative links still resolve", () => {
    expect(resolveExportTarget(dir, "site/css/styles.css")).toBe(
      join(dir, "site/css/styles.css"),
    );
  });

  it("refuses a path that escapes the landing folder", () => {
    for (const hostile of ["../outside.md", "a/../../outside.md", "/etc/passwd"]) {
      expect(() => resolveExportTarget(dir, hostile)).toThrow(/outside/i);
    }
  });
});

describe("planExport", () => {
  const files = [
    file("notes.md", { size: 10 }),
    file("site/index.html", { size: 20 }),
    file("analyse.py", { size: 5 }),
    file(".git/config", { size: 5 }),
  ];

  it("selects every exportable file when nothing is picked, and totals only those", () => {
    const plan = planExport(files);
    expect(plan.selected.map((f) => f.path)).toEqual(["notes.md", "site/index.html"]);
    expect(plan.totalBytes).toBe(30);
    expect(plan.skipped).toBe(2);
    expect(plan.overCap).toBe(false);
  });

  it("classifies every file, keeping the refused ones visible with a reason", () => {
    const plan = planExport(files);
    const py = plan.candidates.find((c) => c.path === "analyse.py")!;
    expect(py.exportable).toBe(false);
    expect(py.reason).toBeTruthy();
    expect(plan.candidates).toHaveLength(4);
  });

  it("honours an explicit selection — unticked files are not saved", () => {
    const plan = planExport(files, ["notes.md"]);
    expect(plan.selected.map((f) => f.path)).toEqual(["notes.md"]);
    expect(plan.totalBytes).toBe(10);
  });

  it("drops a ticked path that is not exportable — the renderer's list is input, not truth", () => {
    const plan = planExport(files, ["notes.md", "analyse.py", ".git/config"]);
    expect(plan.selected.map((f) => f.path)).toEqual(["notes.md"]);
  });

  it("drops a ticked path the Box never listed", () => {
    const plan = planExport(files, ["notes.md", "../../etc/passwd", "ghost.md"]);
    expect(plan.selected.map((f) => f.path)).toEqual(["notes.md"]);
  });

  it("flags a Project over the cap so nothing at all is written", () => {
    const plan = planExport([file("huge.pdf", { size: EXPORT_CAP_BYTES + 1 })]);
    expect(plan.overCap).toBe(true);
    expect(plan.totalBytes).toBe(EXPORT_CAP_BYTES + 1);
    expect(plan.capBytes).toBe(EXPORT_CAP_BYTES);
  });
});

describe("a hostile Project name read straight from Box metadata", () => {
  // The friendly name lives in .claudebox/project.json INSIDE the Box, where
  // Claude can write it. This is the whole path from that file to a host write.
  const fromBox = (name: string) => {
    const json = serializeProjectMeta({ name, slug: "safe-slug" });
    const meta = parseProjectMeta(json)!;
    return resolveExportDir(ROOT, { name: meta.name, slug: meta.slug });
  };

  it("cannot write outside the export root", () => {
    const hostile = [
      "../../../etc",
      "..",
      "../.ssh",
      "/etc/passwd",
      "a/../../b",
      "\u0000\u001b[2Jwiped",
      ".\u007f.",
      "C:\\Windows",
    ];
    for (const name of hostile) {
      const dir = fromBox(name);
      expect(dir.startsWith(ROOT + "/"), name).toBe(true);
      expect(dir, name).not.toContain("..");
      // exactly one segment below the root — no directory hop of any kind
      expect(dir.slice(ROOT.length + 1), name).not.toContain("/");
    }
  });

  it("never lands as a hidden folder the Sandbox User cannot find", () => {
    expect(fromBox(".secret")).toBe(join(ROOT, "secret"));
  });
});

describe("parseBoxFileListing", () => {
  const listing = ["644\t120\tnotes.md", "755\t40\trun.sh", "644\t7\tsite/index.html"].join("\n");

  it("reads mode, size and path from find's output", () => {
    expect(parseBoxFileListing(listing)).toEqual([
      { path: "notes.md", size: 120, executable: false },
      { path: "run.sh", size: 40, executable: true },
      { path: "site/index.html", size: 7, executable: false },
    ]);
  });

  it("treats any executable bit as executable, including group and other", () => {
    const modes = parseBoxFileListing(
      ["744\t1\ta", "654\t1\tb", "641\t1\tc", "666\t1\td"].join("\n"),
    );
    expect(modes.map((f) => f.executable)).toEqual([true, true, true, false]);
  });

  it("skips blank and malformed lines rather than guessing", () => {
    expect(parseBoxFileListing("\n\ngarbage\n644\tnotsize\tx.md\n")).toEqual([]);
  });

  it("keeps a filename containing a tab intact instead of shifting the fields", () => {
    expect(parseBoxFileListing("644\t5\todd\tname.md")).toEqual([
      { path: "odd\tname.md", size: 5, executable: false },
    ]);
  });
});

describe("a crafted selection submitted from the renderer", () => {
  // The renderer's ticked list is input, not truth. This is what the trusted
  // layer does with it: re-classify against the Box's own listing, then resolve
  // each survivor against the landing folder.
  const fromBox = [file("notes.md"), file("site/index.html"), file("secrets.env")];
  const dir = join(ROOT, "My Report");

  const save = (pick: string[]) =>
    planExport(fromBox, pick).selected.map((f) => resolveExportTarget(dir, f.path));

  it("cannot write outside the landing folder", () => {
    const targets = save([
      "notes.md",
      "../../../etc/passwd",
      "../outside.md",
      "/etc/passwd",
      "site/../../escape.html",
      "secrets.env",
    ]);
    expect(targets).toEqual([join(dir, "notes.md")]);
    for (const t of targets) expect(t.startsWith(dir + "/")).toBe(true);
  });

  it("writes nothing at all when nothing is ticked", () => {
    expect(save([])).toEqual([]);
  });
});

describe("boxExport refuses a call with no selection", () => {
  // planExport's no-pick branch selects everything exportable, which is what the
  // listing needs — but it must never become the export's fallback. A caller that
  // omits the selection exports nothing, rather than the whole Project.
  it("throws rather than defaulting to everything", async () => {
    const { boxExport } = await import("../src/main/workspace");
    await expect(
      (boxExport as (s: string, r: string, p?: readonly string[]) => Promise<unknown>)(
        "my-project",
        ROOT,
      ),
    ).rejects.toThrow(/chosen/i);
  });
});
