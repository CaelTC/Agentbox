import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * Thin promise wrapper over spawning `colima` / `docker`. The Launcher owns all
 * these invocations so the Sandbox User never sees a terminal or a Docker
 * command (ticket 04).
 */
export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * A GUI app launched from Finder/Dock inherits a minimal PATH (no login shell),
 * so Homebrew's bin dirs are missing — Apple-Silicon `/opt/homebrew/bin` holds
 * `colima`, hence "spawn colima ENOENT". Prepend the standard Homebrew locations
 * that actually exist so every spawn can find colima/docker. Colleagues without
 * Homebrew get an unchanged PATH (no phantom dirs added).
 * ponytail: covers Homebrew installs; if colima lives elsewhere, add its dir here.
 */
export function spawnPath(path = process.env.PATH ?? "", exists = existsSync): string {
  const brew = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin"];
  const add = brew.filter((d) => exists(d) && !path.split(":").includes(d));
  return [...add, path].filter(Boolean).join(":");
}

export function run(command: string, args: readonly string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PATH: spawnPath() },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/** Run a command and resolve to true only on a clean (exit 0) run. */
export async function runOk(command: string, args: readonly string[]): Promise<boolean> {
  try {
    return (await run(command, args)).code === 0;
  } catch {
    return false;
  }
}
