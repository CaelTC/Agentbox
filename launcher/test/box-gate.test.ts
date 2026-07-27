import { dialog, ipcMain, type IpcMainInvokeEvent } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC } from "../src/shared/api";
import type { UploadTarget } from "../src/core/upload";
import type { Project } from "../src/core/projects";
import { exclusive } from "../src/main/gate";
import { awaitGithubLogin } from "../src/main/github";
import { registerIpc } from "../src/main/ipc";
import { updateClaudebox } from "../src/main/refresh-runner";
import { ensureBoxReady } from "../src/main/session";
import { boxCreateProject, boxUpload } from "../src/main/workspace";
import type { BrowserWindow } from "electron";

/**
 * The Box Gate (#25). The renderer refuses a second operation while one is in
 * flight, but that lock is one window's, over four buttons. Every other
 * Box-touching channel walks straight past it — so "Update Claudebox" could
 * `docker rm -f` the container out from under an Upload that was halfway
 * through copying into it, and the Sandbox User would be handed the Engine's
 * words about a container that no longer exists.
 *
 * These are the two directions of that race, plus the property that makes a
 * queue safe to build out of a promise chain: an operation that throws still
 * hands the gate on.
 */

vi.mock("electron", () => ({
  BrowserWindow: class {},
  ipcMain: { handle: vi.fn() },
  dialog: { showOpenDialog: vi.fn(), showMessageBox: vi.fn() },
  shell: { openExternal: vi.fn(async () => undefined), openPath: vi.fn(async () => "") },
}));

vi.mock("../src/main/session", () => ({
  ensureBoxReady: vi.fn(async () => undefined),
  openProjectSession: vi.fn(async () => undefined),
}));

vi.mock("../src/main/refresh-runner", () => ({ updateClaudebox: vi.fn() }));

vi.mock("../src/main/preview", () => ({ detectPreviewUrl: vi.fn(async () => undefined) }));

vi.mock("../src/main/github", () => ({
  githubStatus: vi.fn(),
  startGithubLogin: vi.fn(),
  awaitGithubLogin: vi.fn(),
  disconnectGithub: vi.fn(),
  saveToGithub: vi.fn(),
}));

vi.mock("../src/main/workspace", () => ({
  boxCreateProject: vi.fn(),
  boxDeleteListing: vi.fn(),
  boxDeleteProject: vi.fn(),
  boxExport: vi.fn(),
  boxExportDir: vi.fn(),
  boxExportListing: vi.fn(),
  boxImportFolder: vi.fn(),
  boxListProjects: vi.fn(),
  boxPlanImport: vi.fn(),
  boxUpload: vi.fn(),
}));

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Drain every pending microtask, so "has it started yet?" is a real question. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("exclusive", () => {
  it("holds the second operation until the first has finished", async () => {
    const first = deferred<string>();
    const started: string[] = [];

    const a = exclusive(() => (started.push("a"), first.promise));
    const b = exclusive(() => (started.push("b"), Promise.resolve("b")));
    await settle();

    expect(started).toEqual(["a"]); // b has not been allowed to begin

    first.resolve("a");
    expect(await a).toBe("a");
    expect(await b).toBe("b");
    expect(started).toEqual(["a", "b"]);
  });

  it("runs queued operations in the order they arrived", async () => {
    const gate = deferred<void>();
    const finished: string[] = [];
    const join = (name: string) =>
      exclusive(async () => {
        await gate.promise;
        finished.push(name);
      });

    const all = [join("first"), join("second"), join("third")];
    gate.resolve();
    await Promise.all(all);

    expect(finished).toEqual(["first", "second", "third"]);
  });

  // A promise chain is only a safe queue if a rejection cannot poison the tail:
  // one failed `docker cp` must not wedge every operation for the rest of the
  // session, which is a deadlock the Sandbox User could only escape by quitting.
  it("hands the gate on when an operation throws, and still rejects its own caller", async () => {
    const failing = exclusive(() => Promise.reject(new Error("docker cp: no space left")));

    await expect(failing).rejects.toThrow("no space left");
    expect(await exclusive(() => "after")).toBe("after");
  });

  it("survives a synchronous throw the same way", async () => {
    await expect(
      exclusive(() => {
        throw new Error("nope");
      }),
    ).rejects.toThrow("nope");
    expect(await exclusive(() => "after")).toBe("after");
  });
});

describe("the router's gate", () => {
  const window = {} as BrowserWindow;

  /** Call a channel's registered handler exactly as `ipcRenderer.invoke` would. */
  const invoke = (channel: string, ...args: unknown[]): Promise<unknown> => {
    const entry = vi.mocked(ipcMain.handle).mock.calls.find(([c]) => c === channel);
    if (!entry) throw new Error(`No handler registered for ${channel}`);
    const handler = entry[1] as (event: IpcMainInvokeEvent, ...a: unknown[]) => unknown;
    return Promise.resolve(handler({} as IpcMainInvokeEvent, ...args));
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Both native dialogs answer immediately: the picker with one file, the
    // Update question with "Update Claudebox".
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({
      canceled: false,
      filePaths: ["/Users/sandbox/notes.csv"],
    });
    vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 0, checkboxChecked: false });
    registerIpc(window);
  });

  it("makes Update Claudebox wait for an Upload that is already in flight", async () => {
    const upload = deferred<UploadTarget[]>();
    vi.mocked(boxUpload).mockReturnValue(upload.promise);

    const uploading = invoke(IPC.upload, "demo");
    await settle();
    expect(boxUpload).toHaveBeenCalled();

    const updating = invoke(IPC.updateBox);
    await settle();

    // The confirmation has been answered — the recreate is what is being held.
    expect(dialog.showMessageBox).toHaveBeenCalled();
    expect(updateClaudebox).not.toHaveBeenCalled();

    const update = deferred<string>();
    vi.mocked(updateClaudebox).mockReturnValue(update.promise);
    upload.resolve([]);
    await uploading;
    await settle();

    expect(updateClaudebox).toHaveBeenCalled();
    update.resolve("Claudebox is up to date.");
    expect(await updating).toBe("Claudebox is up to date.");
  });

  it("makes an Upload wait for an Update that is already in flight", async () => {
    const update = deferred<string>();
    vi.mocked(updateClaudebox).mockReturnValue(update.promise);

    const updating = invoke(IPC.updateBox);
    await settle();
    expect(updateClaudebox).toHaveBeenCalled();

    const uploading = invoke(IPC.upload, "demo");
    await settle();

    // Not even the Box is brought up yet: the recreate is mid-flight, so
    // `ensureBoxReady` would be racing the very container being replaced.
    expect(ensureBoxReady).not.toHaveBeenCalled();
    expect(dialog.showOpenDialog).not.toHaveBeenCalled();

    vi.mocked(boxUpload).mockResolvedValue([]);
    update.resolve("Claudebox is up to date.");
    await updating;
    await settle();

    expect(ensureBoxReady).toHaveBeenCalled();
    expect(await uploading).toEqual([]);
  });

  it("lets the next operation through when the one before it failed", async () => {
    vi.mocked(boxUpload).mockRejectedValue(new Error("docker cp failed"));
    const project: Project = { slug: "demo", name: "Demo", createdAt: 0 };
    vi.mocked(boxCreateProject).mockResolvedValue(project);

    await expect(invoke(IPC.upload, "demo")).rejects.toThrow("docker cp failed");
    expect(await invoke(IPC.createProject, "Demo")).toEqual(project);
  });

  // Signing in is minutes of polling GitHub and never touches the Box, so it is
  // deliberately outside the gate — holding it there would freeze the Launcher
  // behind a device code the Sandbox User may have wandered away from.
  it("does not make the GitHub sign-in poll wait behind an Update", async () => {
    const update = deferred<string>();
    vi.mocked(updateClaudebox).mockReturnValue(update.promise);
    vi.mocked(awaitGithubLogin).mockResolvedValue({
      configured: true,
      connected: true,
      login: "sandbox",
    });

    void invoke(IPC.updateBox);
    await settle();

    expect(await invoke(IPC.awaitGithubLogin)).toMatchObject({ connected: true });

    update.resolve("Claudebox is up to date.");
  });
});
