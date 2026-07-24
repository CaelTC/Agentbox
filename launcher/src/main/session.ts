import { spawn } from "node:child_process";
import { shell } from "electron";
import { BOX_CONTAINER, BOX_IMAGE } from "../core/config";
import { boxRunArgs } from "../core/box";
import { colimaStartArgs } from "../core/colima";
import { chromeAppOpenArgs, ensureSessionExecArgs, sessionUrl } from "../core/session-window";
import { inspectBoxState } from "./environment";
import { run } from "./exec";
import { startupPlan, type StartupStep } from "../core/startup";

/** Start Colima at the Resource Cap if it isn't already up (needed before any docker call). */
export async function ensureColima(): Promise<void> {
  const state = await inspectBoxState();
  if (!state.colimaRunning) {
    await mustSucceed("colima", colimaStartArgs());
  }
}

/**
 * Remove the Box container so the next ensureBoxReady() recreates it from a
 * freshly-rebuilt image. Safe because the Workspace and the Claude login live on
 * named volumes that survive the recreate — only ephemeral container state is lost.
 */
export async function removeBoxContainer(): Promise<void> {
  await run("docker", ["rm", "-f", BOX_CONTAINER]);
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
      await mustSucceed("colima", colimaStartArgs());
      return;
    case "build-image":
      await mustSucceed("docker", ["build", "-t", BOX_IMAGE, boxDefinitionDir]);
      return;
    case "run-box":
      await mustSucceed("docker", boxRunArgs());
      return;
    case "start-box":
      // Restart the existing container, preserving its filesystem (login, etc.).
      await mustSucceed("docker", ["start", BOX_CONTAINER]);
      return;
    case "attach":
      return; // the session is launched by the funnel, opened in Chrome (openProjectSession)
  }
}

async function mustSucceed(command: string, args: readonly string[]): Promise<void> {
  const res = await run(command, args);
  if (res.code !== 0) {
    throw new Error(`\`${command} ${args.join(" ")}\` failed (exit ${res.code}): ${res.stderr}`);
  }
}

/**
 * Open a Project's Claude session (ticket 04). Ensures the session exists through
 * the single Box-side funnel (which reads the Project's cwd + seed prompt from
 * the volume, ticket 02), then shows it in a chromeless Chrome app-mode window.
 * If Chrome is missing, fall back to the default browser so opening never fails.
 * "Reopen terminal" is just this again — the funnel re-attaches the live session.
 */
export async function openProjectSession(slug: string): Promise<void> {
  await mustSucceed("docker", ensureSessionExecArgs(slug));
  const url = sessionUrl(slug);
  const opened = await run("open", chromeAppOpenArgs(url));
  if (opened.code !== 0) {
    await shell.openExternal(url);
  }
}

/**
 * Stop the Box on Launcher quit (ticket 03) to free the Resource Cap. Fire-and-
 * forget in its own process group: a slow or failing `docker stop` must never
 * trap the user in a hanging app — the Resource Cap already bounds a lingering
 * container. Named volumes (Workspace, Claude login) survive the stop.
 */
export function stopBoxDetached(): void {
  try {
    spawn("docker", ["stop", BOX_CONTAINER], { detached: true, stdio: "ignore" }).unref();
  } catch {
    // Engine already gone — nothing to stop.
  }
}
