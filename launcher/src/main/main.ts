import { app, BrowserWindow, dialog } from "electron";
import { join } from "node:path";
import { IPC, type BootstrapStatus } from "../shared/api";
import { registerIpc } from "./ipc";
import { hostBoxDefinitionDir } from "./paths";
import { refreshOnLaunch } from "./refresh-runner";
import {
  ensureBoxReady,
  ensureEngine,
  removeBoxContainer,
  stopBoxDetached,
  updateClaudeCode,
} from "./session";

/**
 * Electron entry point (ticket 04). Double-clicking the Launcher lands here: it
 * opens the home window, wires the trusted IPC surface, and runs bootstrap.
 */
function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 960,
    height: 680,
    title: "Claudebox",
    webPreferences: {
      preload: join(__dirname, "..", "preload.js"),
      contextIsolation: true,
      // The preload require()s local modules (./shared/api) for the IPC contract;
      // a sandboxed preload can only require("electron"), so it would fail to load
      // and window.claudebox would never be exposed. contextIsolation still walls
      // the renderer off from Node — the threat model is the Box, not this local UI.
      sandbox: false,
    },
  });
  void window.loadFile(join(__dirname, "..", "renderer", "index.html"));
  return window;
}

/**
 * Get the Engine and the Box running BEFORE the home screen queries Projects.
 * Order matters: the Engine must be up before Refresh-on-Launch can build,
 * and the Box must be running before Projects (which live on the named volume)
 * can be listed or created. Status is reported to the renderer, not swallowed.
 */
async function bootstrap(window: BrowserWindow): Promise<void> {
  const send = (status: BootstrapStatus) => window.webContents.send(IPC.bootstrap, status);
  try {
    await ensureEngine();
    const refresh = await refreshOnLaunch(); // pull + rebuild only if changed
    if (refresh.action === "error") {
      // Non-fatal for a machine that already has an image; fatal only if there's
      // nothing to run, which ensureBoxReady surfaces below.
      console.warn(`Refresh on Launch: ${refresh.reason}`);
    } else if (refresh.action === "rebuilt") {
      // Recreate the container so the new image is actually used; the login and
      // Workspace survive on their named volumes.
      await removeBoxContainer();
    }
    await ensureBoxReady(hostBoxDefinitionDir());
    // Every open gets the latest Claude Code, before any session can attach.
    send({ ok: true, message: "Updating Claude Code…" });
    if (!(await updateClaudeCode())) {
      console.warn("Claude Code update skipped; keeping the version baked into the Box image.");
    }
    send({ ok: true, message: "Claudebox is ready." });
  } catch (error) {
    send({ ok: false, message: `Couldn't start Claudebox: ${String(error)}` });
  }
}

/** The home window — tracked by identity because Project session windows are now
 * Launcher windows too, so "are there any windows?" no longer answers "is the
 * home screen gone?". Clicking the dock icon must reopen the home screen even
 * when a session window is still up. */
let home: BrowserWindow | undefined;

function openHome(): void {
  home = createWindow();
  home.webContents.once("did-finish-load", () => void bootstrap(home!));
  home.on("closed", () => (home = undefined));
}

app.whenReady().then(() => {
  // Once, not per window: ipcMain handlers are global, so registering a second
  // set for a reopened home window throws ("second handler for 'session:open'").
  registerIpc(() => home);
  openHome();
  app.on("activate", () => {
    if (!home) openHome();
  });
});

app.on("window-all-closed", () => {
  // Standard macOS apps stay alive; quit elsewhere.
  if (process.platform !== "darwin") app.quit();
});

/**
 * The Launcher is the user's on/off switch (ticket 03): quitting it stops the
 * Box to free the Resource Cap, which also ends any open session window —
 * so confirm once before quitting. Stopping is fire-and-forget (stopBoxDetached),
 * so a slow/failed `docker stop` can't trap the user; the quit proceeds regardless.
 */
let quitConfirmed = false;
app.on("before-quit", (event) => {
  if (quitConfirmed) return;
  const choice = dialog.showMessageBoxSync({
    type: "question",
    buttons: ["Quit Claudebox", "Cancel"],
    defaultId: 0,
    cancelId: 1,
    message: "Quit Claudebox?",
    detail: "This closes your Claudebox and any open Claude session. Your projects are saved.",
  });
  if (choice !== 0) {
    event.preventDefault();
    return;
  }
  quitConfirmed = true;
  stopBoxDetached();
});
