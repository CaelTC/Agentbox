import { BOX_CONTAINER, BOX_IMAGE } from "../core/config";
import { boxRunArgs, claudeExecArgs } from "../core/box";
import { colimaStartArgs } from "../core/colima";
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
      return; // attaching is done by the terminal host (see sessionCommand)
  }
}

async function mustSucceed(command: string, args: readonly string[]): Promise<void> {
  const res = await run(command, args);
  if (res.code !== 0) {
    throw new Error(`\`${command} ${args.join(" ")}\` failed (exit ${res.code}): ${res.stderr}`);
  }
}

/**
 * The command that opens an interactive Claude Code session for a Project. The
 * packaged Launcher hosts this in an embedded terminal (xterm.js + node-pty) so
 * the Sandbox User never sees a real terminal; here we expose the exact argv.
 *
 * A seeded first prompt (from a Starter Template, ticket 08) is passed as
 * Claude's initial input so the user lands in a primed session.
 */
export function sessionCommand(cwd: string, seedPrompt?: string): { command: string; args: string[] } {
  const args = claudeExecArgs({ cwd });
  if (seedPrompt) {
    args.push(seedPrompt);
  }
  return { command: "docker", args };
}
