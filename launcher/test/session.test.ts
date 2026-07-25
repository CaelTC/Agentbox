import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { shell } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENGINE_CLI } from "../src/core/config";
import { mustSucceed, run } from "../src/main/exec";
import { openProjectSession } from "../src/main/session";

/**
 * The Windows session-window branch (issue #10). `openProjectSession` takes an
 * injected `platform` precisely so this is assertable from a Mac: the Windows
 * path spawns chrome.exe DETACHED and unawaited, because chrome.exe does not
 * return until the user closes the window. Awaiting it would look fine in
 * manual testing and only misbehave at close time — so it is pinned here.
 */

vi.mock("../src/main/exec", () => ({
  run: vi.fn(),
  runOk: vi.fn(),
  mustSucceed: vi.fn(),
}));

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

// Only existsSync is stubbed: core/projects.ts imports the rest of node:fs.
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  existsSync: vi.fn(() => false),
}));

// `electron` resolves to the binary's path outside an Electron process.
vi.mock("electron", () => ({ shell: { openExternal: vi.fn(async () => undefined) } }));

/** Every spawn made through exec.ts, in order, as `command arg arg…`. */
const calls: string[] = [];
const ok = { code: 0, stdout: "", stderr: "" };

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const URL = "http://localhost:7681/sessions/demo";

/** A spawned chrome.exe that has NOT exited — the state a real session window sits in. */
class FakeChild extends EventEmitter {
  readonly unref = vi.fn();
}
let child: FakeChild;

beforeEach(() => {
  calls.length = 0;
  vi.mocked(mustSucceed).mockImplementation(async (c, a) => {
    calls.push([c, ...a].join(" "));
  });
  vi.mocked(run).mockImplementation(async (c, a) => (calls.push([c, ...a].join(" ")), ok));
  vi.mocked(shell.openExternal).mockClear();
  vi.mocked(shell.openExternal).mockResolvedValue(undefined);

  child = new FakeChild();
  vi.mocked(spawn).mockReset();
  vi.mocked(spawn).mockReturnValue(child as never);

  vi.mocked(existsSync).mockReturnValue(false);
  vi.stubEnv("ProgramFiles", "C:\\Program Files");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Resolve to "pending" if `p` has not settled in a tick or two. */
async function settledOrPending(p: Promise<void>): Promise<string> {
  return Promise.race([
    p.then(() => "settled"),
    new Promise<string>((r) => setTimeout(() => r("pending"), 50)),
  ]);
}

describe("openProjectSession on Windows, Chrome present", () => {
  beforeEach(() => {
    vi.mocked(existsSync).mockReturnValue(true); // the probe finds chrome.exe
  });

  it("ensures the session through the funnel before showing anything", async () => {
    await openProjectSession("demo", "win32");
    expect(calls).toEqual([`${ENGINE_CLI} exec claudebox claudebox-session demo`]);
  });

  it("spawns the probed chrome.exe detached, silent and unref'd", async () => {
    await openProjectSession("demo", "win32");

    expect(spawn).toHaveBeenCalledWith(CHROME, [`--app=${URL}`], {
      detached: true,
      stdio: "ignore",
    });
    expect(child.unref).toHaveBeenCalled();
  });

  it("returns without waiting for the session window to close", async () => {
    // `child` never emits close/exit — chrome.exe stays up for the whole session.
    expect(await settledOrPending(openProjectSession("demo", "win32"))).toBe("settled");

    // Nothing went through exec.ts's run(): rewriting this branch as
    // `await run(launch.command, launch.args)` would block until the user
    // closes the window and fire the fallback at close time, not failure time.
    expect(run).not.toHaveBeenCalled();
    expect(shell.openExternal).not.toHaveBeenCalled();
  });

  it("falls back to the default browser if the spawn fails after the probe", async () => {
    await openProjectSession("demo", "win32");

    // Chrome deleted between the probe and the spawn. Node reports this as an
    // asynchronous 'error' event — an EventEmitter with no 'error' listener
    // rethrows, which in the Launcher means taking the main process down.
    expect(() => child.emit("error", new Error("spawn ENOENT"))).not.toThrow();
    expect(shell.openExternal).toHaveBeenCalledWith(URL);
  });
});

describe("openProjectSession on Windows, Chrome absent", () => {
  it("falls back to the default browser and spawns nothing", async () => {
    vi.mocked(existsSync).mockReturnValue(false); // no chrome.exe in any of the 3 paths

    await openProjectSession("demo", "win32");

    expect(shell.openExternal).toHaveBeenCalledWith(URL);
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("openProjectSession on the Mac — unchanged (issue #10)", () => {
  it("awaits `open` in Chrome app mode and never spawns chrome itself", async () => {
    await openProjectSession("demo", "darwin");

    expect(calls).toEqual([
      `${ENGINE_CLI} exec claudebox claudebox-session demo`,
      `open -na Google Chrome --args --app=${URL}`,
    ]);
    expect(spawn).not.toHaveBeenCalled();
    expect(shell.openExternal).not.toHaveBeenCalled();
  });

  it("falls back to the default browser when `open` exits non-zero", async () => {
    vi.mocked(run).mockResolvedValue({ code: 1, stdout: "", stderr: "no Chrome" });

    await openProjectSession("demo", "darwin");

    expect(shell.openExternal).toHaveBeenCalledWith(URL);
  });
});
