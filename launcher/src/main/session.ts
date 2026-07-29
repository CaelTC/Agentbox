import { BrowserWindow } from "electron";
import { BOX_CONTAINER, BOX_IMAGE, DB_CONTAINER, ENGINE_CLI } from "../core/config";
import {
  boxConnectDbArgs,
  boxRunArgs,
  boxUpdateClaudeArgs,
  dbNetworkCreateArgs,
  dbRunArgs,
} from "../core/box";
import {
  ensureSessionArgs,
  isConsoleUrl,
  sessionUrl,
  sessionWindowOptions,
} from "../core/session-window";
import { boxExec, type BoxExec } from "./box-exec";
import { engine } from "./engine";
import { inspectBoxState } from "./environment";
import { mustSucceed, run } from "./exec";
import { startupPlan, stepMessage, type OnStep, type StartupStep } from "../core/startup";

/**
 * Start the Engine at the Resource Cap if it isn't already up (needed before any
 * engine call). Announces itself only when it actually has to start one: a warm
 * relaunch would otherwise flash "Starting the engine…" at a Sandbox User who
 * waited for nothing.
 */
export async function ensureEngine(onStep?: OnStep): Promise<void> {
  const state = await inspectBoxState();
  if (!state.engineRunning) {
    onStep?.(stepMessage("start-engine")!);
    await engine.start();
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
export async function ensureBoxReady(boxDefinitionDir: string, onStep?: OnStep): Promise<void> {
  const plan = startupPlan(await inspectBoxState());
  for (const step of plan) {
    // Before the step, not after: the whole point is to name the wait while it
    // is being waited on. A warm plan is [attach] alone, which says nothing.
    const message = stepMessage(step);
    if (message) onStep?.(message);
    await runStep(step, boxDefinitionDir);
  }
}

async function runStep(step: StartupStep, boxDefinitionDir: string): Promise<void> {
  switch (step) {
    case "start-engine":
      await engine.start();
      return;
    case "build-image":
      await mustSucceed(ENGINE_CLI, ["build", "-t", BOX_IMAGE, boxDefinitionDir]);
      return;
    case "run-box":
      await ensureDatabase();
      await mustSucceed(ENGINE_CLI, boxRunArgs());
      await mustSucceed(ENGINE_CLI, boxConnectDbArgs());
      return;
    case "start-box":
      await ensureDatabase();
      // Tolerated, not required: a container from before the Database existed
      // was never connected, and connecting one that already is is an error.
      await run(ENGINE_CLI, boxConnectDbArgs());
      // Restart the existing container, preserving its filesystem (login, etc.).
      await mustSucceed(ENGINE_CLI, ["start", BOX_CONTAINER]);
      return;
    case "attach":
      return; // the session is launched by the funnel, shown by openProjectSession
  }
}

/**
 * Bring up the Database beside the Box (CONTEXT.md): postgres on its own
 * internal docker network, reachable from inside the Box and nowhere else.
 * Idempotent — every state (missing, stopped, running) converges in at most
 * three engine calls, so it simply runs before either Box-starting step.
 */
async function ensureDatabase(): Promise<void> {
  // "already exists" is an answer, not a failure.
  await run(ENGINE_CLI, dbNetworkCreateArgs());
  // An existing container — stopped OR running — starts; only absence needs a run.
  const started = await run(ENGINE_CLI, ["start", DB_CONTAINER]);
  if (started.code !== 0) {
    await mustSucceed(ENGINE_CLI, dbRunArgs());
  }
}

/**
 * Update Claude Code in the Box to the latest release, once per launch. Blocking
 * (not backgrounded) so no Project session can start mid-install. Best effort by
 * design: offline, a slow registry or a bad publish must never stop the Box from
 * opening — the version baked into the image keeps working.
 *
 * Hence the `catch`, spelled out here rather than hidden in a wrapper: bootstrap
 * calls this inside the try that reports "Couldn't start Agentbox", so a
 * rejected spawn (no engine on a Finder-launched PATH) would turn a skippable
 * update into a fatal launch. Every way this can go wrong is one `false`.
 *
 * The Box-exec seam's ONE documented exception (main/box-exec.ts): it runs as
 * root, it is best-effort, and it carries its own in-Box `timeout 180`, which is
 * longer than the seam's deadline. The host-side deadline here is the backstop
 * that in-Box `timeout` cannot be — it does nothing for a `docker exec` that
 * never returns, and this one runs holding the Box Gate.
 */
export async function updateClaudeCode(): Promise<boolean> {
  const res = await run(ENGINE_CLI, boxUpdateClaudeArgs(), undefined, 240_000).catch(() => null);
  return res?.code === 0;
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
export async function openProjectSession(slug: string, box: BoxExec = boxExec): Promise<void> {
  // Through the Box-exec seam like every other command against a running Box:
  // the router brings the Box up before this channel's target runs, so there is
  // nothing here that has to reach past it.
  await box.exec(ensureSessionArgs(slug), `Opening the '${slug}' session`);

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
  // Through the Box-exec seam, not a bare `spawn`: this used to lose the
  // `spawnPath()` PATH fix every other Engine call gets, so from a Finder-
  // launched Launcher it was "spawn docker ENOENT" — swallowed by a bare
  // `catch {}`, with the Box left running and holding the Resource Cap.
  boxExec.stopDetached();
}
