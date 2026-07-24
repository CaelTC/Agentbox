import { spawn } from "node:child_process";

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

export function run(command: string, args: readonly string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
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
