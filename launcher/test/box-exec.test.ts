import { spawn } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BOX_CONTAINER, BOX_ROOT_PATH, ENGINE_CLI } from "../src/core/config";
import { BOX_EXEC_TIMEOUT_MS, boxExec, runPipe, sh } from "../src/main/box-exec";
import { run, spawnPath, type RunResult } from "../src/main/exec";

/**
 * The Box-exec seam (main/box-exec.ts): the one place that invokes the Engine
 * CLI against the running Box. Pinned here is the module's own contract — argv
 * shape, shell quoting, the PATH fix, "a non-zero exit is an error", and
 * `runPipe` against real pipelines.
 *
 * The operations built ON this seam are test/workspace.test.ts's, against the
 * fake Box in test/fake-box.ts: they need no mocking at all, because a Box goes
 * in as an argument — which is the point of the interface.
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

  // The sanitized PATH is load-bearing: the image's PATH puts the
  // sandbox-writable /usr/local/cargo/bin first, and a root exec that resolves
  // a bare `rm`/`chown` through it is a plant-a-binary escalation.
  it("runs a root command with -u root and a sanitized PATH, and nothing else does", async () => {
    await boxExec.execAsRoot(["rm", "-rf", "/workspace/demo"]);
    expect(engineCalls).toEqual([
      `${ENGINE_CLI} exec -u root -e PATH=${BOX_ROOT_PATH} ${BOX_CONTAINER} rm -rf /workspace/demo`,
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

  // A `docker exec` that never returns is not one dead operation: the Box Gate
  // is single-file, so it is every Box channel dead for the life of the
  // Launcher — Update Agentbox, the mechanism that would ship the fix, included.
  it("bounds every exec with a deadline, and deliberately does not bound the copies", async () => {
    await boxExec.exec(["ls"]);
    await boxExec.tryExec(["ls"]);
    await boxExec.execAsRoot(["ls"]);
    await boxExec.writeFile("/workspace/demo/a", "hi");
    await boxExec.copyIn("/host/big.zip", "/workspace/demo/big.zip");
    await boxExec.copyOut("/workspace/demo/big.zip", "/host/big.zip");

    // A multi-GB Import or Export is legitimately slow, and holding the gate for
    // it is correct — a copy is exactly the thing nothing else may race.
    expect(vi.mocked(run).mock.calls.map((call) => call[3])).toEqual([
      BOX_EXEC_TIMEOUT_MS,
      BOX_EXEC_TIMEOUT_MS,
      BOX_EXEC_TIMEOUT_MS,
      BOX_EXEC_TIMEOUT_MS,
      undefined,
      undefined,
    ]);
  });

  it("sends file content as base64, so arbitrary content never meets a shell", async () => {
    const content = `{"name":"Rock & Roll'; rm -rf /"}`;
    await boxExec.writeFile("/workspace/demo/.agentbox/project.json", content);

    const [, argv] = vi.mocked(run).mock.calls[0]!;
    expect(argv).not.toContain(content);
    const b64 = argv[argv.length - 2]!; // sh -c SCRIPT sh <b64> <path>
    expect(Buffer.from(b64, "base64").toString("utf8")).toBe(content);
    expect(argv[argv.length - 1]).toBe("/workspace/demo/.agentbox/project.json");
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

  // The affordance that keeps callers from misusing `tryExec` to reword a
  // failure: naming the operation is the seam's job, at the call site's request.
  it("names the operation instead of the argv when a caller says what it was doing", async () => {
    await expect(boxExec.exec(["df", "-kP", "/workspace"], "Reading the Box's free space"))
      .rejects.toThrow(/^Reading the Box's free space failed \(exit 1\): permission denied$/);
    await expect(boxExec.execAsRoot(["rm", "-rf", "/x"], "Deleting 'demo'")).rejects.toThrow(
      /^Deleting 'demo' failed/,
    );
  });

  it("resolves — never throws — for tryExec, the one tolerant operation", async () => {
    await expect(boxExec.tryExec(["test", "-e", "/workspace/gone"])).resolves.toMatchObject({
      code: 1,
    });
  });

  // `run` REJECTS when the Engine binary cannot be spawned at all, and every
  // tolerant call site reads `.code` off a result it assumes it has. A rejection
  // there is an unhandled throw out of a function documented never to throw.
  it("resolves for tryExec even when the Engine cannot be spawned at all", async () => {
    vi.mocked(run).mockRejectedValue(new Error("spawn docker ENOENT"));

    await expect(boxExec.tryExec(["test", "-e", "/workspace/gone"])).resolves.toMatchObject({
      code: -1,
      stderr: expect.stringContaining("ENOENT"),
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
