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

export interface PipeStage {
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * Pipe `a`'s stdout into `b`'s stdin, spawned directly — no `sh -c`. Import
 * (ticket 09) is the first host-side command built from a user-chosen path
 * (the folder they picked); a shell there is a quoting hazard for nothing.
 *
 * `input` is written to `a`'s stdin and resolves with BOTH stages' stderr.
 */
export function runPipe(a: PipeStage, b: PipeStage, input = ""): Promise<RunResult> {
  return new Promise((promiseResolve, reject) => {
    const env = { ...process.env, PATH: spawnPath() };
    const first = spawn(a.command, a.args, { stdio: ["pipe", "pipe", "pipe"], env });
    const second = spawn(b.command, b.args, { stdio: ["pipe", "pipe", "pipe"], env });

    first.stdout.pipe(second.stdin);
    // `b` exiting early makes the pipe write EPIPE. Node emits that on the
    // stream, and an 'error' with no listener takes down the whole Launcher.
    second.stdin.on("error", () => {});

    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    first.on("error", fail);
    second.on("error", fail);

    let stdout = "";
    let stderr = "";
    second.stdout.on("data", (d) => (stdout += String(d)));
    first.stderr.on("data", (d) => (stderr += String(d)));
    second.stderr.on("data", (d) => (stderr += String(d)));

    // BOTH exit codes matter, and `a`'s is reported first: a `tar` that dies
    // mid-stream still leaves `docker cp` exiting 0 on the truncated archive it
    // did receive, so checking only `b` reports a partial copy as a success.
    let firstCode: number | null = null;
    let secondCode: number | null = null;
    const settle = () => {
      if (settled || firstCode === null || secondCode === null) return;
      settled = true;
      promiseResolve({ code: firstCode !== 0 ? firstCode : secondCode, stdout, stderr });
    };
    first.on("close", (code) => ((firstCode = code ?? -1), settle()));
    second.on("close", (code) => ((secondCode = code ?? -1), settle()));

    first.stdin.end(input);
  });
}
