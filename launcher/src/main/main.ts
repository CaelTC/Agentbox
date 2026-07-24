import { app, BrowserWindow } from "electron";
import { join } from "node:path";
import { IPC, type BootstrapStatus } from "../shared/api";
import { registerIpc } from "./ipc";
import { hostBoxDefinitionDir } from "./paths";
import { refreshOnLaunch } from "./refresh-runner";
import { ensureBoxReady, ensureColima, removeBoxContainer } from "./session";

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
    },
  });
  void window.loadFile(join(__dirname, "..", "renderer", "index.html"));
  return window;
}

/**
 * Get the Engine and the Box running BEFORE the home screen queries Projects.
 * Order matters: Colima must be up before Refresh-on-Launch can `docker build`,
 * and the Box must be running before Projects (which live on the named volume)
 * can be listed or created. Status is reported to the renderer, not swallowed.
 */
async function bootstrap(window: BrowserWindow): Promise<void> {
  const send = (status: BootstrapStatus) => window.webContents.send(IPC.bootstrap, status);
  try {
    await ensureColima();
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
    send({ ok: true, message: "Claudebox is ready." });
  } catch (error) {
    send({ ok: false, message: `Couldn't start Claudebox: ${String(error)}` });
  }
}

app.whenReady().then(() => {
  const window = createWindow();
  registerIpc(window);
  window.webContents.once("did-finish-load", () => void bootstrap(window));

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const w = createWindow();
      registerIpc(w);
      w.webContents.once("did-finish-load", () => void bootstrap(w));
    }
  });
});

app.on("window-all-closed", () => {
  // Standard macOS apps stay alive; quit elsewhere.
  if (process.platform !== "darwin") app.quit();
});
