import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * Thin promise wrapper over spawning `colima` / `docker` / `git`. The Launcher
 * owns all these invocations so the Sandbox User never sees a terminal or a
 * Docker command (ticket 04).
 *
 * TWO contracts, and only two, because two are what more than one module shares:
 * `run` (resolve the result, exit code included) and `mustSucceed` (throw its
 * stderr on a non-zero exit). A caller for whom a non-zero exit is an ANSWER
 * rather than a failure reads `.code` itself, at the call site, where the reason
 * can be written down — that is a line, not a contract.
 *
 * Anything with a single consumer lives with that consumer instead: `runPipe`
 * moved to `main/box-exec.ts`, the only module that streams into the Box.
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
 *
 * Windows returns PATH untouched: there is no Homebrew there, `podman` comes
 * from a per-user installer already on PATH, and `":"` is not the separator.
 */
export function spawnPath(
  path = process.env.PATH ?? "",
  exists = existsSync,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") return path;
  const brew = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin"];
  const add = brew.filter((d) => exists(d) && !path.split(":").includes(d));
  return [...add, path].filter(Boolean).join(":");
}

/**
 * `env` adds variables to the spawn's environment. The GitHub token travels this
 * way and never as an argument (ADR 0006): argv is world-readable in `ps`, so a
 * token on the command line is a token any process on the laptop can read.
 */
export function run(
  command: string,
  args: readonly string[],
  env?: Readonly<Record<string, string>>,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env, PATH: spawnPath() },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/** Run a command, throwing its stderr if it did not exit 0. */
export async function mustSucceed(command: string, args: readonly string[]): Promise<void> {
  const res = await run(command, args);
  if (res.code !== 0) {
    throw new Error(`\`${command} ${args.join(" ")}\` failed (exit ${res.code}): ${res.stderr}`);
  }
}
