import { app, BrowserWindow, dialog } from "electron";
import { join } from "node:path";
import { IPC, type BootstrapStatus } from "../shared/api";
import { boxGate } from "./box-gate";
import { homeListedProjects, registerIpc } from "./ipc";
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
 *
 * Held under the Box Gate, because Refresh on Launch is an Update Claudebox that
 * nobody pressed: the home screen is already loaded and clickable while this
 * runs (that is what `did-finish-load` means), and its first `listProjects` —
 * or an impatient "Update Claudebox" — would otherwise reach a container this
 * is in the middle of removing and recreating. Taking the gate turns that race
 * into a queue. Nothing in here goes back through the router, so there is no
 * way for the gate to wait on itself.
 *
 * TWO turns at the gate, not one. The Box being ready is what the home screen
 * waits on; the Claude Code update is a separate operation, queued behind the
 * home screen's own first listing, so the Projects appear as soon as the Box is
 * up. Held as one, `claude update` (up to `timeout 180`) sat in front of the
 * home screen on every single launch — and the "Updating Claude Code…" status
 * that was supposed to explain the wait could never be seen, because the window
 * was still empty. That status is gone rather than moved: an `ok` status is what
 * makes the renderer draw the home screen, so the honest number of them is one.
 */
async function bootstrap(window: BrowserWindow): Promise<void> {
  const send = (status: BootstrapStatus) => window.webContents.send(IPC.bootstrap, status);
  try {
    await boxGate(async () => {
      await ensureEngine();
      const refresh = await refreshOnLaunch(); // pull + rebuild only if changed
      if (refresh.action === "error" || refresh.action === "blocked") {
        // Non-fatal for a machine that already has an image; fatal only if there's
        // nothing to run, which ensureBoxReady surfaces below. A `blocked` is the
        // integrity gate declining an untrusted definition — the one outcome that
        // must never pass unlogged.
        console.warn(`Refresh on Launch: ${refresh.reason}`);
      } else if (refresh.action === "rebuilt") {
        // Recreate the container so the new image is actually used; the login and
        // Workspace survive on their named volumes.
        await removeBoxContainer();
      }
      await ensureBoxReady(hostBoxDefinitionDir());
    });
    // The Box is usable from here on, so this is the Sandbox User's last word on
    // it — and the only one: an `ok` status is what makes the renderer draw the
    // home screen, so a second would redraw it under whatever they were doing.
    // The update reports itself to the console instead, which is all a
    // best-effort step that changes nothing on screen has to say.
    send({ ok: true, message: "Claudebox is ready." });
    // Behind the home screen's own first listing, never in front of it (see
    // `homeListedProjects`); capped, so a window that never asks for its
    // Projects doesn't skip the update for the whole launch. Still before any
    // session can attach — every later click queues behind this at the gate,
    // `openSession` included.
    await Promise.race([homeListedProjects, new Promise((r) => setTimeout(r, 5_000).unref())]);
    await boxGate(async () => {
      if (!(await updateClaudeCode())) {
        console.warn("Claude Code update skipped; keeping the version baked into the Box image.");
      }
    });
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

/**
 * The Launcher is the user's on/off switch (ticket 03): quitting it stops the
 * Box to free the Resource Cap, which also ends any open Chrome session window —
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
    buttons: ["Quit Claudebox", "Cancel"],
    defaultId: 0,
    cancelId: 1,
    message: "Quit Claudebox?",
    detail: "This closes your Claudebox and any open Claude session. Your projects are saved.",
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
