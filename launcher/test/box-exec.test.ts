import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BOX_CONTAINER, ENGINE_CLI } from "../src/core/config";
import { boxExec, runPipe, sh, type BoxExec } from "../src/main/box-exec";
import { run, spawnPath, type RunResult } from "../src/main/exec";
import {
  boxCreateProject,
  boxDeleteListing,
  boxDeleteProject,
  boxExport,
  boxImportFolder,
  boxListProjects,
  boxUpload,
} from "../src/main/workspace";

/**
 * The Box-exec seam (main/box-exec.ts): the one place that invokes the Engine
 * CLI against the running Box.
 *
 * Two things are pinned here. First the module's own contract — argv shape,
 * shell quoting, the PATH fix, and "a non-zero exit is an error". Second, the
 * failure paths in main/workspace.ts that this seam exists to stop swallowing:
 * before it, six `run()` results were discarded, so a `docker cp` that copied
 * nothing still reported "Uploaded 3 file(s)" to the Sandbox User.
 *
 * The Workspace half needs no `vi.mock` of `./exec` at all — a fake Box goes in
 * as an argument, which is the point of the interface.
 */

// `spawnPath` stays REAL: stopDetached exists to apply it.
vi.mock("../src/main/exec", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/main/exec")>()),
  run: vi.fn(),
}));

/**
 * `spawn` is mocked only so `stopDetached` can be inspected without launching
 * anything — every other test gets the real one back in `beforeEach`, because
 * `runPipe` (this module's own, since `copyInStream` is its only caller) is
 * asserted against real pipelines at the foot of this file.
 */
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: vi.fn(),
}));
const realSpawn = (await vi.importActual<typeof import("node:child_process")>("node:child_process"))
  .spawn;

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
const boom = (stderr = "no such container"): RunResult => ({ code: 1, stdout: "", stderr });

/** Every engine argv `boxExec` produced, as one string. */
const engineCalls: string[] = [];

beforeEach(() => {
  engineCalls.length = 0;
  vi.mocked(run).mockReset();
  vi.mocked(run).mockImplementation(async (command, args) => {
    engineCalls.push([command, ...args].join(" "));
    return ok();
  });
  vi.mocked(spawn).mockReset();
  vi.mocked(spawn).mockImplementation(realSpawn);
});

describe("sh — the module's answer to shell quoting", () => {
  it("passes values as positional parameters, so nothing is ever interpolated", () => {
    expect(sh('cd "$1" && ls', "/workspace/my-site")).toEqual([
      "sh",
      "-c",
      'cd "$1" && ls',
      "sh",
      "/workspace/my-site",
    ]);
  });

  it("cannot be broken by a value that is shell syntax — it never joins the script", () => {
    const nasty = `/workspace/'; rm -rf /; echo '`;
    const argv = sh('cd "$1"', nasty);
    expect(argv[2]).toBe('cd "$1"'); // the script is untouched
    expect(argv).toContain(nasty); // the value is its own argv word
  });

  it("sets $0 so the first value really is $1 (POSIX `sh -c SCRIPT NAME ARG…`)", () => {
    expect(sh("true", "a", "b").slice(3)).toEqual(["sh", "a", "b"]);
  });
});

describe("boxExec argv", () => {
  it("runs a command in the Box as the sandbox user", async () => {
    await boxExec.exec(["mkdir", "-p", "/workspace/demo"]);
    expect(engineCalls).toEqual([`${ENGINE_CLI} exec ${BOX_CONTAINER} mkdir -p /workspace/demo`]);
  });

  it("runs a root command with -u root, and nothing else does", async () => {
    await boxExec.execAsRoot(["rm", "-rf", "/workspace/demo"]);
    expect(engineCalls).toEqual([
      `${ENGINE_CLI} exec -u root ${BOX_CONTAINER} rm -rf /workspace/demo`,
    ]);
  });

  it("owns the `container:` prefix on both copy directions", async () => {
    await boxExec.copyIn("/host/budget.csv", "/workspace/demo/budget.csv");
    await boxExec.copyOut("/workspace/demo/report.md", "/host/report.md");
    expect(engineCalls).toEqual([
      `${ENGINE_CLI} cp /host/budget.csv ${BOX_CONTAINER}:/workspace/demo/budget.csv`,
      `${ENGINE_CLI} cp ${BOX_CONTAINER}:/workspace/demo/report.md /host/report.md`,
    ]);
  });

  it("sends file content as base64, so arbitrary content never meets a shell", async () => {
    const content = `{"name":"Rock & Roll'; rm -rf /"}`;
    await boxExec.writeFile("/workspace/demo/.claudebox/project.json", content);

    const [, argv] = vi.mocked(run).mock.calls[0]!;
    expect(argv).not.toContain(content);
    const b64 = argv[argv.length - 2]!; // sh -c SCRIPT sh <b64> <path>
    expect(Buffer.from(b64, "base64").toString("utf8")).toBe(content);
    expect(argv[argv.length - 1]).toBe("/workspace/demo/.claudebox/project.json");
  });
});

describe("boxExec failure contract", () => {
  beforeEach(() => {
    vi.mocked(run).mockResolvedValue(boom("permission denied"));
  });

  it("throws on a non-zero exit, naming the command and its stderr", async () => {
    await expect(boxExec.exec(["mkdir", "-p", "/workspace/demo"])).rejects.toThrow(
      /mkdir -p \/workspace\/demo.*exit 1.*permission denied/s,
    );
  });

  it("throws for root commands, copies and writes too", async () => {
    await expect(boxExec.execAsRoot(["rm", "-rf", "/x"])).rejects.toThrow(/exit 1/);
    await expect(boxExec.copyIn("/host/a", "/workspace/a")).rejects.toThrow(/exit 1/);
    await expect(boxExec.copyOut("/workspace/a", "/host/a")).rejects.toThrow(/exit 1/);
    await expect(boxExec.writeFile("/workspace/a", "hi")).rejects.toThrow(/Writing '\/workspace\/a'/);
  });

  it("resolves — never throws — for tryExec, the one tolerant operation", async () => {
    await expect(boxExec.tryExec(["test", "-e", "/workspace/gone"])).resolves.toMatchObject({
      code: 1,
    });
  });
});

describe("stopDetached", () => {
  it("carries the PATH fix a bare spawn was losing (session.ts's `catch {}`)", () => {
    const child = { on: vi.fn(), unref: vi.fn() };
    vi.mocked(spawn).mockReturnValue(child as never);

    boxExec.stopDetached();

    expect(spawn).toHaveBeenCalledWith(ENGINE_CLI, ["stop", BOX_CONTAINER], {
      detached: true,
      stdio: "ignore",
      env: expect.objectContaining({ PATH: spawnPath() }),
    });
    expect(child.unref).toHaveBeenCalled();
  });

  it("listens for the spawn's async 'error', which would otherwise kill the quit", () => {
    const child = { on: vi.fn(), unref: vi.fn() };
    vi.mocked(spawn).mockReturnValue(child as never);

    boxExec.stopDetached();

    expect(child.on).toHaveBeenCalledWith("error", expect.any(Function));
  });
});

/* ------------------------------------------------------------------------- *
 * The Workspace, against a fake Box.
 * ------------------------------------------------------------------------- */

type Op =
  | "exec"
  | "tryExec"
  | "execAsRoot"
  | "writeFile"
  | "copyIn"
  | "copyOut"
  | "copyInStream"
  | "stopDetached";

interface FakeBox extends BoxExec {
  /** Every operation performed, as `op arg arg…`, in order. */
  readonly calls: string[];
}

/**
 * A Box that answers with whatever `reply` returns — a string for stdout, an
 * Error to make that one operation fail. This is the whole test double: no
 * module mocking, because the seam is an argument.
 */
function fakeBox(reply: (op: Op, args: readonly string[]) => string | Error = () => ""): FakeBox {
  const calls: string[] = [];
  const answer = (op: Op, args: readonly string[]): string => {
    calls.push([op, ...args].join(" "));
    const replied = reply(op, args);
    if (replied instanceof Error) throw replied;
    return replied;
  };
  return {
    calls,
    exec: async (argv) => answer("exec", argv),
    tryExec: async (argv) => {
      calls.push(["tryExec", ...argv].join(" "));
      const replied = reply("tryExec", argv);
      return replied instanceof Error
        ? { code: 1, stdout: "", stderr: replied.message }
        : { code: 0, stdout: replied, stderr: "" };
    },
    execAsRoot: async (argv) => void answer("execAsRoot", argv),
    writeFile: async (path, content) => void answer("writeFile", [path, content]),
    copyIn: async (hostPath, boxPath) => void answer("copyIn", [hostPath, boxPath]),
    copyOut: async (boxPath, hostPath) => void answer("copyOut", [boxPath, hostPath]),
    copyInStream: async (source, dir) => void answer("copyInStream", [source.command, dir]),
    stopDetached: () => void answer("stopDetached", []),
  };
}

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
  it("kills the session as the sandbox user — never as root", async () => {
    const fake = fakeBox();
    // Every `test -e` succeeds in this fake, so the Project reads as still
    // present after the rm — which is the OTHER guarantee this operation makes.
    await expect(boxDeleteProject("demo", "demo", fake)).rejects.toThrow(/still in the Workspace/);

    expect(fake.calls).toContain("tryExec tmux kill-session -t demo");
    expect(fake.calls).toContain("execAsRoot rm -rf /workspace/demo");
    expect(fake.calls.some((c) => c.startsWith("execAsRoot tmux"))).toBe(false);
  });

  it("reports the Project's name when the removal itself fails", async () => {
    const fake = fakeBox((op) => (op === "execAsRoot" ? new Error("device or resource busy") : ""));
    await expect(boxDeleteProject("demo", "demo", fake)).rejects.toThrow(
      /Couldn't delete 'demo'.*device or resource busy/s,
    );
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

  it("reports when the Exported copies that SURVIVE this delete last landed", async () => {
    mkdirSync(join(root, "My Site"), { recursive: true });

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

/* ------------------------------------------------------------------------- *
 * `runPipe` — `copyInStream`'s plumbing, against real processes.
 * ------------------------------------------------------------------------- */

describe("runPipe", () => {
  // The precedence rule below is the whole reason this function was rewritten:
  // Import shipped once reporting success on a copy that moved nothing.
  it("reports the FIRST stage's failure even when the second exits 0", async () => {
    const res = await runPipe(
      { command: "sh", args: ["-c", "printf partial; exit 3"] },
      { command: "cat", args: [] },
    );
    expect(res.code).toBe(3);
  });

  it("reports the second stage's failure when the first is clean", async () => {
    const res = await runPipe(
      { command: "sh", args: ["-c", "printf ok"] },
      { command: "sh", args: ["-c", "cat >/dev/null; exit 4"] },
    );
    expect(res.code).toBe(4);
  });

  it("succeeds and returns the second stage's stdout when both are clean", async () => {
    const res = await runPipe({ command: "cat", args: [] }, { command: "cat", args: [] }, "hello");
    expect(res.code).toBe(0);
    expect(res.stdout).toBe("hello");
  });

  // A second stage that exits before reading makes the pipe write EPIPE. An
  // unlistened 'error' takes the Launcher's main process down — and merely
  // swallowing it is not enough either: the first stage then blocks forever on
  // a buffer nobody drains, so this test hangs rather than fails if that
  // teardown regresses. Resolving at all IS the assertion.
  it("survives the second stage exiting without reading its input", async () => {
    const res = await runPipe(
      { command: "sh", args: ["-c", "printf 'x%.0s' $(seq 1 200000)"] },
      { command: "sh", args: ["-c", "exit 0"] },
    );
    expect(typeof res.code).toBe("number");
  }, 5_000);

  // The mirror case: a first stage that exits without reading its stdin. EPIPE
  // lands on the write side instead, and is just as fatal unlistened.
  it("survives the first stage exiting without reading its input", async () => {
    const res = await runPipe(
      { command: "sh", args: ["-c", "exit 5"] },
      { command: "cat", args: [] },
      "x".repeat(200_000),
    );
    expect(res.code).toBe(5);
  }, 5_000);
});
