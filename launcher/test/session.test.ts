import { beforeEach, describe, expect, it, vi } from "vitest";
import { ENGINE_CLI } from "../src/core/config";
import { mustSucceed, run } from "../src/main/exec";
import { openProjectSession, updateClaudeCode } from "../src/main/session";

/**
 * One window per Project, and only one. The session window is the Launcher's own
 * (it used to be a Chrome app window, which answered to no one), and this is
 * what that buys: a second "Open session" for a live Project raises the window
 * that exists instead of stacking another view of the same tmux session on it.
 *
 * Pinned here because the failure is invisible in a quick manual test — two
 * identical windows showing the same session look exactly like one working one.
 */

// `failureMessage` and `spawnPath` stay REAL: the funnel now goes through the
// Box-exec seam, which builds its errors and its PATH out of them.
vi.mock("../src/main/exec", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/main/exec")>()),
  run: vi.fn(),
  mustSucceed: vi.fn(),
}));

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

/** A stand-in for Electron's BrowserWindow, recording what was done to it. */
const { FakeWindow } = vi.hoisted(() => {
  class FakeWindow {
    static created: FakeWindow[] = [];
    readonly loadURL = vi.fn(async () => undefined);
    readonly focus = vi.fn();
    readonly show = vi.fn();
    readonly restore = vi.fn();
    readonly webContents = {
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
    };
    private readonly listeners = new Map<string, () => void>();
    destroyed = false;
    minimized = false;

    constructor(readonly options: Record<string, unknown>) {
      FakeWindow.created.push(this);
    }
    isDestroyed(): boolean {
      return this.destroyed;
    }
    isMinimized(): boolean {
      return this.minimized;
    }
    on(event: string, listener: () => void): this {
      this.listeners.set(event, listener);
      return this;
    }
    /** What the user closing the window does: destroyed, then 'closed' fires. */
    close(): void {
      this.destroyed = true;
      this.listeners.get("closed")?.();
    }
  }
  return { FakeWindow };
});

// `electron` resolves to the binary's path outside an Electron process.
vi.mock("electron", () => ({
  BrowserWindow: FakeWindow,
  shell: { openExternal: vi.fn(async () => undefined) },
}));

/** Every spawn made through exec.ts, in order, as `command arg arg…`. */
const calls: string[] = [];
const ok = { code: 0, stdout: "", stderr: "" };

const URL = "http://localhost:7681/sessions/demo";
const windows = () => FakeWindow.created;
const only = () => {
  expect(windows()).toHaveLength(1);
  return windows()[0]!;
};

beforeEach(() => {
  calls.length = 0;
  vi.mocked(mustSucceed).mockImplementation(async (c, a) => {
    calls.push([c, ...a].join(" "));
  });
  vi.mocked(run).mockImplementation(async (c, a) => (calls.push([c, ...a].join(" ")), ok));

  // The registry in session.ts is module state that outlives one test: close
  // every window this test file opened so the next test starts with none open.
  for (const w of windows()) if (!w.isDestroyed()) w.close();
  FakeWindow.created = [];
});

describe("openProjectSession", () => {
  it("ensures the session through the funnel before showing anything", async () => {
    await openProjectSession("demo");
    expect(calls).toEqual([`${ENGINE_CLI} exec claudebox claudebox-session demo`]);
  });

  it("opens one window on the Project's console URL", async () => {
    await openProjectSession("demo");
    expect(only().loadURL).toHaveBeenCalledWith(URL);
  });
});

describe("openProjectSession, called again for a Project already open", () => {
  it("raises the window that exists and opens no second one", async () => {
    await openProjectSession("demo");
    const first = only();

    await openProjectSession("demo");

    expect(windows()).toHaveLength(1); // NOT a second view of the same session
    expect(first.focus).toHaveBeenCalled();
    expect(first.show).toHaveBeenCalled();
    expect(first.loadURL).toHaveBeenCalledTimes(1); // and not reloaded under the user
  });

  it("restores it first when it is minimized", async () => {
    await openProjectSession("demo");
    const window = only();
    window.minimized = true;

    await openProjectSession("demo");

    // focus() does nothing to a minimized window on Windows — without this,
    // clicking Open session for a minimized session appears to do nothing at all.
    expect(window.restore).toHaveBeenCalled();
  });

  it("still runs the funnel, so a session whose tmux side died is rebuilt", async () => {
    await openProjectSession("demo");
    await openProjectSession("demo");
    expect(calls).toEqual([
      `${ENGINE_CLI} exec claudebox claudebox-session demo`,
      `${ENGINE_CLI} exec claudebox claudebox-session demo`,
    ]);
  });
});

describe("openProjectSession across Projects and closes", () => {
  it("gives each Project its own window", async () => {
    await openProjectSession("demo");
    await openProjectSession("other");

    expect(windows()).toHaveLength(2);
    expect(windows()[1]!.loadURL).toHaveBeenCalledWith("http://localhost:7681/sessions/other");
  });

  it("opens a fresh window after the user closed the old one", async () => {
    await openProjectSession("demo");
    only().close(); // the registry must forget a window that no longer exists

    await openProjectSession("demo");

    expect(windows()).toHaveLength(2);
    expect(windows()[1]!.loadURL).toHaveBeenCalledWith(URL);
  });
});

describe("the session window is held to the Box's console", () => {
  /** The `will-navigate` guard session.ts installed, as a predicate. */
  async function navigationAllowed(target: string): Promise<boolean> {
    await openProjectSession("demo");
    const [event, listener] = only().webContents.on.mock.calls[0]!;
    expect(event).toBe("will-navigate");

    let prevented = false;
    (listener as (e: { preventDefault(): void }, url: string) => void)(
      { preventDefault: () => (prevented = true) },
      target,
    );
    return !prevented;
  }

  it("lets the console move between its own pages", async () => {
    expect(await navigationAllowed(`${URL}/files`)).toBe(true);
  });

  it("refuses to be navigated off the console by the page inside it", async () => {
    // The page is served from the Box — the untrusted side of the boundary.
    expect(await navigationAllowed("http://example.com/")).toBe(false);
  });

  it("denies popups outright", async () => {
    await openProjectSession("demo");
    const [handler] = only().webContents.setWindowOpenHandler.mock.calls[0]!;
    expect((handler as (d: { url: string }) => unknown)({ url: "http://example.com/" })).toEqual({
      action: "deny",
    });
  });
});

/**
 * The funnel crosses the Box-exec seam like everything else that reaches a
 * running Box — so a Box that cannot start the session says so, in the Box's
 * terms, instead of handing the Sandbox User a raw `docker exec` line.
 */
describe("openProjectSession when the funnel fails", () => {
  it("names the operation rather than the docker argv, and opens no window", async () => {
    vi.mocked(run).mockResolvedValue({ code: 1, stdout: "", stderr: "no such container" });

    await expect(openProjectSession("demo")).rejects.toThrow(
      /Opening the 'demo' session failed.*no such container/s,
    );
    expect(windows()).toHaveLength(0);
  });
});

/**
 * The best-effort contract, spelled out at the call site now that `runOk` is
 * gone. `bootstrap` awaits this INSIDE the try that reports "Couldn't start
 * Claudebox", so anything that escapes here turns a skippable Claude Code
 * update into a failed launch.
 */
describe("updateClaudeCode is best effort", () => {
  it("is false, not a throw, when the Engine cannot even be spawned", async () => {
    vi.mocked(run).mockRejectedValue(new Error("spawn docker ENOENT"));
    await expect(updateClaudeCode()).resolves.toBe(false);
  });

  it("is false when the update ran and failed (offline registry)", async () => {
    vi.mocked(run).mockResolvedValue({ code: 1, stdout: "", stderr: "ETIMEDOUT" });
    await expect(updateClaudeCode()).resolves.toBe(false);
  });

  it("is true on a clean update", async () => {
    await expect(updateClaudeCode()).resolves.toBe(true);
  });
});
