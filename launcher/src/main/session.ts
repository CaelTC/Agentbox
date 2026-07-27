import { spawn } from "node:child_process";
import { shell } from "electron";
import { BOX_CONTAINER, BOX_IMAGE, ENGINE_CLI } from "../core/config";
import { boxRunArgs, boxUpdateClaudeArgs } from "../core/box";
import { chromeAppLaunch, ensureSessionExecArgs, sessionUrl } from "../core/session-window";
import { boxExec } from "./box-exec";
import { engine } from "./engine";
import { inspectBoxState } from "./environment";
import { mustSucceed, run } from "./exec";
import { startupPlan, type StartupStep } from "../core/startup";

/** Start the Engine at the Resource Cap if it isn't already up (needed before any engine call). */
export async function ensureEngine(): Promise<void> {
  const state = await inspectBoxState();
  if (!state.engineRunning) {
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
export async function ensureBoxReady(boxDefinitionDir: string): Promise<void> {
  const plan = startupPlan(await inspectBoxState());
  for (const step of plan) {
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
      await mustSucceed(ENGINE_CLI, boxRunArgs());
      return;
    case "start-box":
      // Restart the existing container, preserving its filesystem (login, etc.).
      await mustSucceed(ENGINE_CLI, ["start", BOX_CONTAINER]);
      return;
    case "attach":
      return; // the session is launched by the funnel, opened in Chrome (openProjectSession)
  }
}

/**
 * Update Claude Code in the Box to the latest release, once per launch. Blocking
 * (not backgrounded) so no Project session can start mid-install. Best effort by
 * design: offline, a slow registry or a bad publish must never stop the Box from
 * opening — the version baked into the image keeps working.
 *
 * Hence the `catch`, spelled out here rather than hidden in a wrapper: bootstrap
 * calls this inside the try that reports "Couldn't start Claudebox", so a
 * rejected spawn (no engine on a Finder-launched PATH) would turn a skippable
 * update into a fatal launch. Every way this can go wrong is one `false`.
 */
export async function updateClaudeCode(): Promise<boolean> {
  const res = await run(ENGINE_CLI, boxUpdateClaudeArgs()).catch(() => null);
  return res?.code === 0;
}

/**
 * Open a Project's Claude session (ticket 04). Ensures the session exists through
 * the single Box-side funnel (which reads the Project's cwd + seed prompt from
 * the volume, ticket 02), then shows it in a chromeless Chrome app-mode window.
 * If Chrome is missing, fall back to the default browser so opening never fails.
 * "Reopen terminal" is just this again — the funnel re-attaches the live session.
 */
export async function openProjectSession(
  slug: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  await mustSucceed(ENGINE_CLI, ensureSessionExecArgs(slug));
  const url = sessionUrl(slug);
  const launch = chromeAppLaunch(url, platform);
  if (!launch) {
    await shell.openExternal(url);
    return;
  }

  // Windows spawns chrome.exe itself, detached and unawaited: chrome.exe does not
  // return until the user closes the session window (issue #10). `open` on the Mac
  // returns immediately and reports a real failure, so it keeps its await below.
  if (platform === "win32") {
    const child = spawn(launch.command, [...launch.args], { detached: true, stdio: "ignore" });
    // Chrome went away between the probe and the spawn — same fallback. Node
    // reports a failed spawn asynchronously, never as a throw, and an unhandled
    // 'error' would take the Launcher's main process down with it.
    child.on("error", () => void shell.openExternal(url).catch(() => {}));
    child.unref();
    return;
  }

  const opened = await run(launch.command, launch.args);
  if (opened.code !== 0) {
    await shell.openExternal(url);
  }
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
