import { mkdirSync, mkdtempSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SAVED_STAMP } from "../src/core/export";
import { importTarArgs, importTarInput } from "../src/core/import";
import { run, type RunResult } from "../src/main/exec";
import {
  boxCreateProject,
  boxDeleteListing,
  boxDeleteProject,
  boxExport,
  boxImportFolder,
  boxListProjects,
  boxUpload,
  lastSavedAt,
} from "../src/main/workspace";
import { fakeBox, type Op } from "./fake-box";

/**
 * The Workspace operations (main/workspace.ts), against a fake Box.
 *
 * These need no `vi.mock` of the Box at all — one goes in as an argument, which
 * is the point of the Box-exec seam. What is pinned here is the failure paths
 * that seam exists to stop swallowing (before it, six `run()` results were
 * discarded, so a `docker cp` that copied nothing still reported "Uploaded 3
 * file(s)"), and the Import payload that crosses into the Box.
 *
 * `./exec` IS mocked, because Import's `git` calls and Export's `xattr` are HOST
 * commands and really would run.
 */

vi.mock("../src/main/exec", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/main/exec")>()),
  run: vi.fn(),
}));

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
const boom = (stderr = "no such container"): RunResult => ({ code: 1, stdout: "", stderr });

beforeEach(() => {
  vi.mocked(run).mockReset();
  vi.mocked(run).mockResolvedValue(ok());
});

/** Recognise which Box-side probe an argv is, without asserting its exact script. */
const isSlugListing = (argv: readonly string[]) => argv.join(" ").includes("basename");
const isFileListing = (argv: readonly string[]) => argv.join(" ").includes("-printf");
const isDf = (argv: readonly string[]) => argv[0] === "df";
const isUsage = (argv: readonly string[]) => argv.join(" ").includes("du -sk");
const isMeta = (argv: readonly string[]) => argv[0] === "cat";

describe("boxUpload — a failed copy is not an upload", () => {
  const sources = ["/host/budget.csv", "/host/notes.txt"];

  it("reports the files it copied when every copy lands", async () => {
    const box = fakeBox();
    const copied = await boxUpload(sources, "demo", box);

    expect(copied.map((t) => t.dest)).toEqual([
      "/workspace/demo/budget.csv",
      "/workspace/demo/notes.txt",
    ]);
    expect(box.calls).toContain("copyIn /host/budget.csv /workspace/demo/budget.csv");
  });

  // The bug this seam was built for: `run()`'s result was dropped, so a
  // `docker cp` that copied nothing still returned the target list, and the
  // renderer flashed "Uploaded 2 file(s) into Demo".
  it("throws instead of returning targets when a copy fails", async () => {
    const box = fakeBox((op) => (op === "copyIn" ? new Error("no space left on device") : ""));

    await expect(boxUpload(sources, "demo", box)).rejects.toThrow(/no space left/);
  });

  it("stops at the first failed copy rather than reporting the rest as copied", async () => {
    const box = fakeBox((op, args) =>
      op === "copyIn" && args[0] === "/host/budget.csv" ? new Error("cp failed") : "",
    );

    await expect(boxUpload(sources, "demo", box)).rejects.toThrow(/cp failed/);
    expect(box.calls.filter((c) => c.startsWith("copyIn"))).toHaveLength(1);
  });
});

describe("boxCreateProject — a Project that isn't there is not a Project", () => {
  it("creates the folder and writes the metadata", async () => {
    const box = fakeBox((op, argv) => (op === "tryExec" && argv[0] === "test" ? new Error("") : ""));
    const project = await boxCreateProject("My Site", undefined, box);

    expect(project).toMatchObject({ name: "My Site", slug: "my-site" });
    expect(box.calls).toContain("exec mkdir -p /workspace/my-site/.claudebox");
    expect(box.calls.some((c) => c.startsWith("writeFile /workspace/my-site/.claudebox"))).toBe(
      true,
    );
  });

  // Previously silent: the Project came back anyway, and the home screen
  // rendered it by its raw slug because there was no project.json to read.
  it("throws when the metadata write fails", async () => {
    const box = fakeBox((op, argv) => {
      if (op === "tryExec" && argv[0] === "test") return new Error("");
      return op === "writeFile" ? new Error("read-only file system") : "";
    });

    await expect(boxCreateProject("My Site", undefined, box)).rejects.toThrow(/read-only/);
  });

  it("throws when the folder itself could not be made", async () => {
    const box = fakeBox((op, argv) => {
      if (op === "tryExec" && argv[0] === "test") return new Error("");
      return op === "exec" ? new Error("mkdir: permission denied") : "";
    });

    await expect(boxCreateProject("My Site", undefined, box)).rejects.toThrow(/permission denied/);
  });
});

describe("boxListProjects — an unreadable Workspace is not an empty one", () => {
  it("lists the slugs the Box reported", async () => {
    const box = fakeBox((op, argv) => (isSlugListing(argv) ? "my-site\ndemo\n" : ""));
    const projects = await boxListProjects(box);
    expect(projects.map((p) => p.slug)).toEqual(["demo", "my-site"]);
  });

  it("throws rather than telling a Sandbox User they have no Projects", async () => {
    const box = fakeBox((_op, argv) =>
      isSlugListing(argv) ? new Error("Error: No such container: claudebox") : "",
    );
    await expect(boxListProjects(box)).rejects.toThrow(/No such container/);
  });
});

describe("boxDeleteProject", () => {
  /**
   * A Box where the `rm` actually works: the Project answers `test -e` until it
   * is removed, and not afterwards. Every other fake here leaves it present, so
   * the operation could only ever be observed failing — and the DeleteResult the
   * renderer branches on (two different sentences) was pinned by nothing.
   */
  const deletingBox = (live: boolean, name = "My Site") => {
    let removed = false;
    return fakeBox((op, argv) => {
      if (op === "execAsRoot" && argv[0] === "rm") removed = true;
      if (op === "tryExec" && argv[0] === "test") return removed ? new Error("") : "";
      if (op === "tryExec" && argv[0] === "tmux") return live ? "" : new Error("no session found");
      if (isMeta(argv)) return JSON.stringify({ name, slug: "demo" });
      return "";
    });
  };

  it("reports the Project it deleted, and that a live session went with it", async () => {
    const fake = deletingBox(true);

    expect(await boxDeleteProject("demo", "My Site", fake)).toEqual({
      slug: "demo",
      name: "My Site",
      // The renderer says "Its Claude window is finished — you can close it" on
      // this, and stays quiet on false. A stuck `true` tells every Sandbox User
      // to close a window that was never open.
      sessionKilled: true,
    });
    expect(fake.calls).toContain("execAsRoot rm -rf /workspace/demo");
  });

  it("reports sessionKilled false when there was no session to kill", async () => {
    expect(await boxDeleteProject("demo", "My Site", deletingBox(false))).toEqual({
      slug: "demo",
      name: "My Site",
      sessionKilled: false,
    });
  });

  it("kills the session as the sandbox user — never as root", async () => {
    const fake = fakeBox();
    // Every `test -e` succeeds in this fake, so the Project reads as still
    // present after the rm — which is the OTHER guarantee this operation makes.
    await expect(boxDeleteProject("demo", "demo", fake)).rejects.toThrow(/still in the Workspace/);

    expect(fake.calls).toContain("tryExec tmux kill-session -t demo");
    expect(fake.calls).toContain("execAsRoot rm -rf /workspace/demo");
    expect(fake.calls.some((c) => c.startsWith("execAsRoot tmux"))).toBe(false);
  });

  // The wording is the seam's now (`what`), not a try/catch here that caught an
  // error only to reword it — so what this pins is that the reason survives.
  it("reports why the removal failed", async () => {
    const fake = fakeBox((op) => (op === "execAsRoot" ? new Error("device or resource busy") : ""));
    await expect(boxDeleteProject("demo", "demo", fake)).rejects.toThrow(/device or resource busy/);
  });

  // The typed name is checked against the Box's own metadata, not against
  // whatever the sheet was showing: a stale sheet naming a since-renamed Project
  // must not be able to delete it.
  it("removes NOTHING when the typed name isn't this Project's", async () => {
    const fake = fakeBox((_op, argv) =>
      isMeta(argv) ? JSON.stringify({ name: "My Site", slug: "demo" }) : "",
    );

    await expect(boxDeleteProject("demo", "My Old Site", fake)).rejects.toThrow(
      /isn't the name of this project/,
    );
    expect(fake.calls.some((c) => c.includes("rm -rf"))).toBe(false);
    expect(fake.calls.some((c) => c.includes("kill-session"))).toBe(false);
  });

  it("accepts the friendly name the way a person types it (case, stray spaces)", async () => {
    const fake = fakeBox((_op, argv) =>
      isMeta(argv) ? JSON.stringify({ name: "My Site", slug: "demo" }) : "",
    );

    // Gets past the check and on to the removal, which this fake then fails.
    await expect(boxDeleteProject("demo", "  my site ", fake)).rejects.toThrow(
      /still in the Workspace/,
    );
  });
});

describe("boxDeleteListing — the sheet between a click and permanent loss", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "claudebox-delete-"));
  });

  /** A Box holding one Project, "My Site", whose size probe answers `usage`. */
  const box = (usage: string | Error) =>
    fakeBox((_op, argv) => {
      if (isSlugListing(argv)) return "demo\n";
      if (isMeta(argv)) return JSON.stringify({ name: "My Site", slug: "demo" });
      if (isUsage(argv)) return usage;
      return "";
    });

  it("reports the friendly name, what the Project holds, and where its Exports are", async () => {
    const listing = await boxDeleteListing("demo", root, box("3\n8\n"));

    expect(listing).toMatchObject({
      slug: "demo",
      name: "My Site",
      fileCount: 3,
      totalBytes: 8 * 1024,
    });
    expect(listing.exportDir).toBe(join(root, "My Site"));
  });

  // The one thing this sheet must never do is show a confident "0 files" over a
  // Project full of work — absent is a different answer from zero.
  it("leaves the counts ABSENT when the size probe failed", async () => {
    const listing = await boxDeleteListing("demo", root, box(new Error("no such container")));

    expect("fileCount" in listing).toBe(false);
    expect("totalBytes" in listing).toBe(false);
    expect(listing.name).toBe("My Site"); // still says what is about to go
  });

  it("has no lastSaved when this Project was never saved out", async () => {
    expect((await boxDeleteListing("demo", root, box("1\n1\n"))).lastSaved).toBeUndefined();
  });

  // A landing folder can exist without an Export ever having landed in it, and
  // this sheet is the one place where the difference is load-bearing: it must
  // not promise surviving copies over a folder that only Finder ever touched.
  it("has no lastSaved when the folder is there but nothing was ever saved into it", async () => {
    mkdirSync(join(root, "My Site"), { recursive: true });

    expect((await boxDeleteListing("demo", root, box("1\n1\n"))).lastSaved).toBeUndefined();
  });

  it("reports when the Exported copies that SURVIVE this delete last landed", async () => {
    mkdirSync(join(root, "My Site"), { recursive: true });
    writeFileSync(join(root, "My Site", SAVED_STAMP), "2026-07-01T00:00:00.000Z\n");

    expect((await boxDeleteListing("demo", root, box("1\n1\n"))).lastSaved).toBeGreaterThan(0);
  });
});

describe("boxExport — `saved: N` is a promise about files on the disk", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "claudebox-export-"));
  });

  const listing = (argv: readonly string[]): string | undefined => {
    if (isSlugListing(argv)) return "demo\n";
    if (isFileListing(argv)) return "100644\t12\tnotes.md\n";
    return undefined;
  };

  it("throws when a file could not be copied out", async () => {
    const box = fakeBox((op, argv) => {
      const canned = listing(argv);
      if (canned !== undefined) return canned;
      return op === "copyOut" ? new Error("no such file or directory") : "";
    });

    await expect(boxExport("demo", root, ["notes.md"], box)).rejects.toThrow(/no such file/);
  });

  it("reports what it saved when the copies land", async () => {
    // A copy that really lands, so the chmod/mark that follow have a file.
    const box = fakeBox((op, argv) => {
      const canned = listing(argv);
      if (canned !== undefined) return canned;
      if (op === "copyOut") writeFileSync(argv[1]!, "hello");
      return "";
    });

    const result = await boxExport("demo", root, ["notes.md"], box);
    expect(result.saved).toBe(1);
  });

  /**
   * `find` exits 1 for ANY per-file traversal error — a file a running dev
   * server unlinked between the walk reaching its directory and reaching it —
   * while still printing every other file. Read as a failure, that ends an
   * Export the Sandbox User could otherwise have completed.
   */
  it("saves the files `find` did print, even when `find` exited non-zero", async () => {
    const box = fakeBox((op, argv) => {
      if (isSlugListing(argv)) return "demo\n";
      if (isFileListing(argv)) {
        return { code: 1, stdout: "100644\t12\tnotes.md\n", stderr: "find: './tmp/x': No such file" };
      }
      if (op === "copyOut") writeFileSync(argv[1]!, "hello");
      return "";
    });

    expect((await boxExport("demo", root, ["notes.md"], box)).saved).toBe(1);
  });

  // The other half: nothing printed AND a failure is the case the old throw was
  // really for. An empty listing there would offer nothing to save — and, from
  // the delete sheet, report that nothing is about to be lost.
  it("still throws when the listing failed with nothing printed at all", async () => {
    const box = fakeBox((_op, argv) => {
      if (isSlugListing(argv)) return "demo\n";
      if (isFileListing(argv)) {
        return { code: 1, stdout: "", stderr: "Error: No such container: claudebox" };
      }
      return "";
    });

    await expect(boxExport("demo", root, ["notes.md"], box)).rejects.toThrow(
      /Couldn't list the files in 'demo'.*No such container/s,
    );
  });

  // Files that landed before a mid-loop failure are on the user's disk, and
  // "last saved" is what Show saved files, the delete sheet and the home screen
  // report about them. The stamp is a file of its own rather than the folder's
  // mtime, which anything writing into the folder — Finder included — bumps.
  it("stamps 'last saved' when a copy fails part-way, for the files that landed", async () => {
    const box = fakeBox((op, argv) => {
      if (isSlugListing(argv)) return "demo\n";
      if (isFileListing(argv)) return "100644\t12\tnotes.md\n100644\t12\treport.md\n";
      if (op === "copyOut") {
        if (argv[0]!.endsWith("report.md")) return new Error("no such file or directory");
        writeFileSync(argv[1]!, "hello");
      }
      return "";
    });

    const before = Date.now() - 60_000;
    const dir = join(root, "demo");
    const stamp = join(dir, SAVED_STAMP);
    mkdirSync(dir, { recursive: true });
    writeFileSync(stamp, "old\n");
    utimesSync(stamp, new Date(before), new Date(before));

    await expect(boxExport("demo", root, ["notes.md", "report.md"], box)).rejects.toThrow(
      /no such file/,
    );
    expect(statSync(stamp).mtimeMs).toBeGreaterThan(before);
  });

  // The folder's own mtime is what this stamp exists NOT to be: Finder bumps it
  // by opening the folder, and "Saved just now" is then a claim about a
  // months-old Export that nothing in the app can tell apart from a real one.
  it("records the save in a file of its own, not in the landing folder's mtime", async () => {
    const box = fakeBox((op, argv) => {
      if (isSlugListing(argv)) return "demo\n";
      if (isFileListing(argv)) return "100644\t12\tnotes.md\n";
      if (op === "copyOut") writeFileSync(argv[1]!, "hello");
      return "";
    });

    const dir = join(root, "demo");
    await boxExport("demo", root, ["notes.md"], box);

    const saved = statSync(join(dir, SAVED_STAMP)).mtimeMs;
    // Anything at all landing in the folder afterwards — a .DS_Store is the one
    // that happens in the wild — moves the folder on and leaves the stamp alone.
    writeFileSync(join(dir, ".DS_Store"), "finder");
    expect(statSync(join(dir, SAVED_STAMP)).mtimeMs).toBe(saved);
    expect(lastSavedAt(dir)).toBe(saved);
  });
});

describe("boxImportFolder", () => {
  let folder: string;

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), "claudebox-import-"));
    writeFileSync(join(folder, "index.html"), "<h1>hi</h1>");
    // `isGitRepo` / `gitLsFilesRaw` are HOST `git` calls through exec.ts, not
    // Box calls — non-zero here means "not a repo", so the plain walk is used.
    vi.mocked(run).mockResolvedValue(boom("not a git repository"));
  });

  /** Enough free space, an empty Workspace, everything else fine. */
  const importBox = (reply: (op: Op, args: readonly string[]) => string | Error = () => "") =>
    fakeBox((op, argv) => {
      if (isDf(argv)) return "Filesystem 1024-blocks Used Available Capacity\n/dev/x 100 1 99999999 1%\n";
      if (isSlugListing(argv)) return "";
      return reply(op, argv);
    });

  it("chowns the tree to the sandbox user after the stream lands", async () => {
    const box = importBox();
    const project = await boxImportFolder(folder, box);

    expect(project.slug).toBeTruthy();
    expect(box.calls).toContain(`copyInStream tar ${project.dir}`);
    expect(box.calls).toContain(`execAsRoot chown -R sandbox:sandbox ${project.dir}`);
  });

  /**
   * The one stream is the whole Import: `tar -c … -C <folder>` is WHAT crosses,
   * its stdin is WHICH FILES, and the Box directory is WHERE it lands. Recorded
   * as the command name alone, all three were unassertable — tar'ing the wrong
   * directory, or importing a repo without its history, passed every test here.
   */
  it("tars the chosen folder into the new Project, feeding tar the exact file list", async () => {
    const box = importBox();
    const project = await boxImportFolder(folder, box);

    expect(box.streams).toHaveLength(1);
    const [{ source, dir, input }] = box.streams;
    expect(source.command).toBe("tar");
    expect(source.args).toEqual(importTarArgs(folder, false));
    expect(source.args).toContain(folder); // the picked folder, not the Box's
    expect(dir).toBe(project.dir);
    expect(input).toBe(importTarInput(["index.html"]));
  });

  // `.git` is never listed by `git ls-files`; it rides along as an extra
  // positional path, and carrying it is the deliberate decision in the ADR. A
  // flipped flag here is a repo that arrives with no history at all.
  it("carries .git for a real repo, and the paths git listed", async () => {
    // Really on disk: the import sizes every listed path before it packs it.
    mkdirSync(join(folder, "src"));
    writeFileSync(join(folder, "src", "app.ts"), "export {};");
    vi.mocked(run).mockImplementation(async (_command, args) =>
      args.includes("rev-parse") ? ok("true\n") : ok("index.html\0src/app.ts\0"),
    );

    const box = importBox();
    await boxImportFolder(folder, box);
    const [{ source, input }] = box.streams;

    expect(source.args).toEqual(importTarArgs(folder, true));
    expect(source.args).toContain(".git");
    expect(input).toBe(importTarInput(["index.html", "src/app.ts"]));
  });

  it("carries no .git when the folder is not a repo", async () => {
    const box = importBox();
    await boxImportFolder(folder, box);

    expect(box.streams[0].source.args).not.toContain(".git");
  });

  // Previously silent: an unchowned import comes back looking fine and is
  // unusable the moment Claude opens it ("dubious ownership", unwritable dirs).
  it("throws when the chown fails, rather than handing back a broken Project", async () => {
    const box = importBox((op, argv) =>
      op === "execAsRoot" && argv[0] === "chown" ? new Error("operation not permitted") : "",
    );
    await expect(boxImportFolder(folder, box)).rejects.toThrow(/operation not permitted/);
  });

  it("removes the half-copied folder as root when the stream fails, and says so", async () => {
    const box = importBox((op) => (op === "copyInStream" ? new Error("tar: broken pipe") : ""));

    await expect(boxImportFolder(folder, box)).rejects.toThrow(/Import failed copying.*broken pipe/s);
    expect(box.calls.some((c) => c.startsWith("execAsRoot rm -rf /workspace/"))).toBe(true);
  });

  it("reports a failed cleanup alongside the copy failure, never instead of it", async () => {
    const box = importBox((op) =>
      op === "copyInStream"
        ? new Error("tar: broken pipe")
        : op === "execAsRoot"
          ? new Error("rm: device busy")
          : "",
    );

    await expect(boxImportFolder(folder, box)).rejects.toThrow(
      /broken pipe.*could not be removed either.*device busy/s,
    );
  });

  it("throws when the metadata write fails, so no Project lands without its name", async () => {
    const box = importBox((op) => (op === "writeFile" ? new Error("read-only file system") : ""));
    await expect(boxImportFolder(folder, box)).rejects.toThrow(/read-only/);
  });
});