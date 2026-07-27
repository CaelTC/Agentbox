import { spawn } from "node:child_process";
import { BrowserWindow } from "electron";
import { BOX_CONTAINER, BOX_IMAGE, ENGINE_CLI } from "../core/config";
import { boxRunArgs, boxUpdateClaudeArgs } from "../core/box";
import {
  ensureSessionExecArgs,
  isConsoleUrl,
  sessionUrl,
  sessionWindowOptions,
} from "../core/session-window";
import { startEngine } from "./engine";
import { inspectBoxState } from "./environment";
import { mustSucceed, run, runOk } from "./exec";
import { startupPlan, type StartupStep } from "../core/startup";

/** Start the Engine at the Resource Cap if it isn't already up (needed before any engine call). */
export async function ensureEngine(): Promise<void> {
  const state = await inspectBoxState();
  if (!state.colimaRunning) {
    await startEngine();
  }
}

/**
 * Remove the Box container so the next ensureBoxReady() recreates it from a
 * freshly-rebuilt image. Safe because the Workspace and the Claude login live on
 * named volumes that survive the recreate — only ephemeral container state is lost.
 */
export async function removeBoxContainer(): Promise<void> {
  await run(ENGINE_CLI, ["rm", "-f", BOX_CONTAINER]);
}

/**
 * Bring the Box up to the point where a Claude session can attach (ticket 04).
 * Uses the pure startupPlan() to decide the minimal ordered steps, then runs
 * them. On a warm machine this collapses to a no-op so reopening is fast; a
 * stopped container is restarted (not recreated) so the login survives.
 */
export async function ensureBoxReady(boxDefinitionDir: string): Promise<void> {
  const plan = startupPlan(await inspectBoxState());
  for (const step of plan) {
    await runStep(step, boxDefinitionDir);
  }
}

async function runStep(step: StartupStep, boxDefinitionDir: string): Promise<void> {
  switch (step) {
    case "start-colima":
      await startEngine();
      return;
    case "build-image":
      await mustSucceed(ENGINE_CLI, ["build", "-t", BOX_IMAGE, boxDefinitionDir]);
      return;
    case "run-box":
      await mustSucceed(ENGINE_CLI, boxRunArgs());
      return;
    case "start-box":
      // Restart the existing container, preserving its filesystem (login, etc.).
      await mustSucceed(ENGINE_CLI, ["start", BOX_CONTAINER]);
      return;
    case "attach":
      return; // the session is launched by the funnel, shown by openProjectSession
  }
}

/**
 * Update Claude Code in the Box to the latest release, once per launch. Blocking
 * (not backgrounded) so no Project session can start mid-install. Best effort by
 * design: offline, a slow registry or a bad publish must never stop the Box from
 * opening — the version baked into the image keeps working.
 */
export async function updateClaudeCode(): Promise<boolean> {
  return runOk(ENGINE_CLI, boxUpdateClaudeArgs());
}

/**
 * The session window this Launcher has open for each Project, by slug. One tmux
 * session per Project means one window per Project: this registry is what lets
 * a second "Open session" raise the window that already exists instead of
 * stacking another view of the same session on top of it.
 */
const sessionWindows = new Map<string, BrowserWindow>();

/**
 * Open a Project's Claude session (ticket 04). Ensures the session exists through
 * the single Box-side funnel (which reads the Project's cwd + seed prompt from
 * the volume, ticket 02), then shows it in a window the Launcher owns.
 *
 * Called again for a Project that is already open, this raises that window and
 * opens nothing — the funnel is still run first, so a session whose tmux side
 * died is rebuilt before the existing window is brought back to it.
 */
export async function openProjectSession(slug: string): Promise<void> {
  await mustSucceed(ENGINE_CLI, ensureSessionExecArgs(slug));

  const open = sessionWindows.get(slug);
  if (open && !open.isDestroyed()) {
    // focus() alone does nothing to a minimized window on Windows, and only
    // sometimes on the Mac — restore first so "bring it to the front" is honest.
    if (open.isMinimized()) open.restore();
    open.show();
    open.focus();
    return;
  }

  const window = new BrowserWindow(sessionWindowOptions(slug));
  sessionWindows.set(slug, window);
  // Only forget this window if it is still the one registered: a stale 'closed'
  // arriving after the Project was reopened must not evict the live window.
  window.on("closed", () => {
    if (sessionWindows.get(slug) === window) sessionWindows.delete(slug);
  });
  confineToConsole(window);
  await window.loadURL(sessionUrl(slug));
}

/**
 * Hold the session window to the Box's console. The page inside it is served
 * from the Box, which is the untrusted side of the boundary (ADR 0001) — so it
 * may move around the console's own pages (Files, the session rail) and nowhere
 * else, and it may not open windows at all. Denying popups outright keeps the
 * Box from ever putting a URL of its choosing in front of the user: it renders
 * the console, it does not get to steer the Launcher.
 */
function confineToConsole(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (!isConsoleUrl(url)) event.preventDefault();
  });
}

/**
 * Stop the Box on Launcher quit (ticket 03) to free the Resource Cap. Fire-and-
 * forget in its own process group: a slow or failing `stop` must never trap the
 * user in a hanging app — the Resource Cap already bounds a lingering container.
 * Named volumes (Workspace, Claude login) survive the stop.
 */
export function stopBoxDetached(): void {
  try {
    spawn(ENGINE_CLI, ["stop", BOX_CONTAINER], { detached: true, stdio: "ignore" }).unref();
  } catch {
    // Engine already gone — nothing to stop.
  }
}
