import { app, BrowserWindow, dialog } from "electron";
import { join } from "node:path";
import { IPC } from "../shared/api";
import { bootstrap } from "./bootstrap";
import { boxGate } from "./box-gate";
import { registerIpc } from "./ipc";
import { stopBoxDetached } from "./session";

/**
 * Electron entry point (ticket 04). Double-clicking the Launcher lands here: it
 * opens the home window, wires the trusted IPC surface, and runs bootstrap.
 */
function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 960,
    height: 680,
    title: "Agentbox",
    webPreferences: {
      preload: join(__dirname, "..", "preload.js"),
      contextIsolation: true,
      // The preload require()s local modules (./shared/api) for the IPC contract;
      // a sandboxed preload can only require("electron"), so it would fail to load
      // and window.agentbox would never be exposed. contextIsolation still walls
      // the renderer off from Node — the threat model is the Box, not this local UI.
      sandbox: false,
    },
  });
  void window.loadFile(join(__dirname, "..", "renderer", "index.html"));
  return window;
}

/**
 * Run the launch sequence and pipe its status to this window. The sequence
 * itself is `main/bootstrap.ts` — everything here is the wiring it deliberately
 * knows nothing about.
 */
const launch = (window: BrowserWindow): Promise<void> =>
  bootstrap((status) => window.webContents.send(IPC.bootstrap, status));

/** The home window — tracked by identity because Project session windows are now
 * Launcher windows too, so "are there any windows?" no longer answers "is the
 * home screen gone?". Clicking the dock icon must reopen the home screen even
 * when a session window is still up. */
let home: BrowserWindow | undefined;

function openHome(): void {
  home = createWindow();
  home.webContents.once("did-finish-load", () => void launch(home!));
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
 *
 * The stop itself takes the gate, though: quitting mid-Import would otherwise
 * stop the container in the middle of a `tar | docker cp`, leaving exactly the
 * half-copied, metadata-less Project that Import's own cleanup exists to
 * prevent. So a quit while the Box is busy defers once — the quit is re-issued
 * as soon as the gate comes free, and `quitting` keeps that from looping.
 */
let quitConfirmed = false;
let boxStopped = false;
app.on("before-quit", (event) => {
  if (boxStopped) return; // the stop has run — this is the quit going through
  event.preventDefault();
  if (quitConfirmed) return; // already waiting at the gate; don't ask twice
  const choice = dialog.showMessageBoxSync({
    type: "question",
    buttons: ["Quit Agentbox", "Cancel"],
    defaultId: 0,
    cancelId: 1,
    message: "Quit Agentbox?",
    detail: "This closes your Agentbox and any open Claude session. Your projects are saved.",
  });
  if (choice !== 0) return; // cancelled — the quit is already prevented
  quitConfirmed = true;
  // An empty turn at the gate: it resolves on the spot when nothing is in
  // flight, so an idle quit is not delayed at all, and waits out a copy when
  // one is. Then stop, and re-quit — this handler lets that one through.
  void boxGate(() => {}).then(() => {
    boxStopped = true;
    stopBoxDetached();
    app.quit();
  });
});
