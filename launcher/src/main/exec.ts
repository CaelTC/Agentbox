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
 * `failureMessage` is the sentence both of those failures are reported as, and
 * is exported because the Box-exec seam raises the same one about the Box.
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

/** How long a killed child is given to die politely before SIGKILL. */
const KILL_GRACE_MS = 2_000;

/**
 * `env` adds variables to the spawn's environment. The GitHub token travels this
 * way and never as an argument (ADR 0006): argv is world-readable in `ps`, so a
 * token on the command line is a token any process on the laptop can read.
 *
 * `timeoutMs` bounds how long the child may live. Without it a command that
 * never exits never settles — and a `docker exec` into a Box whose tmux server
 * Claude has just SIGSTOPped does exactly that, taking the Box Gate down with it
 * for the life of the process: every Box-touching channel, Update Agentbox
 * included, queues behind a promise that will never resolve. A timeout is
 * SIGTERM, then SIGKILL after a grace, and resolves like any other failure —
 * non-zero, with the deadline named in `stderr`, so callers need no new branch.
 */
export function run(
  command: string,
  args: readonly string[],
  env?: Readonly<Record<string, string>>,
  timeoutMs?: number,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    // `detached` gives the child a process GROUP of its own, which is what the
    // deadline below signals. See `killGroup`.
    const group = process.platform !== "win32";
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env, PATH: spawnPath() },
      detached: group,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));

    /**
     * The GROUP, not the child. This promise resolves on 'close', which waits
     * for the stdout/stderr pipes — and a child leaves those pipes to ITS
     * children: `docker exec` runs a shell, that shell runs the command, and
     * every one of them inherits the write end. Signal the direct child alone
     * and the grandchild lives on holding the pipe, so 'close' never arrives
     * and the deadline fails at the only thing it exists to guarantee — a
     * hung exec still taking the single-file Box Gate down for the life of the
     * Launcher. Measured: 9019ms to settle a 150ms deadline, versus 165ms once
     * the group is signalled.
     *
     * Windows has no process groups to signal and `kill` there already ends the
     * process, so it takes the direct-child path.
     */
    const killGroup = (signal: NodeJS.Signals) => {
      try {
        if (group && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        // Already gone — the race this loses is the one we wanted.
      }
    };

    // SIGKILL after the grace because SIGTERM is ignorable and the whole point
    // here is that 'close' — and so this promise — is guaranteed to arrive.
    let kill: NodeJS.Timeout | undefined;
    const deadline =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            killGroup("SIGTERM");
            kill = setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS);
          }, timeoutMs);
    const done = () => (clearTimeout(deadline), clearTimeout(kill));

    child.on("error", (err) => (done(), reject(err)));
    child.on("close", (code) => {
      done();
      const note = timedOut ? `timed out after ${timeoutMs}ms` : "";
      resolve({ code: timedOut ? -1 : (code ?? -1), stdout, stderr: stderr + note });
    });
  });
}

/**
 * How much of a failed command's output reaches the screen. A failed `docker
 * build` writes hundreds of lines, and the Launcher has no log file and no
 * devtools — so this screen is the only place the reason exists, and it is also
 * a `<p>` in front of a non-technical Sandbox User. The TAIL is what is kept:
 * the head of a build log is cache hits, the error is at the end. The character
 * bound is not the line bound in other clothes — BuildKit's default progress
 * output is ANSI redraws, which arrive as one enormous line.
 */
const DETAIL_LINES = 15;
const DETAIL_CHARS = 800;

/** The one sentence a failed command is reported as, here and at the Box-exec seam. */
export function failureMessage(what: string, res: RunResult): string {
  const raw = res.stderr.trim() || res.stdout.trim() || "no output";
  const lines = raw.split("\n");
  let detail = lines.length > DETAIL_LINES ? lines.slice(-DETAIL_LINES).join("\n") : raw;
  if (detail.length > DETAIL_CHARS) detail = detail.slice(-DETAIL_CHARS);
  return `${what} failed (exit ${res.code}): ${detail.length < raw.length ? `…\n${detail}` : detail}`;
}

/** Run a command, throwing its stderr if it did not exit 0. */
export async function mustSucceed(command: string, args: readonly string[]): Promise<void> {
  const res = await run(command, args);
  if (res.code !== 0) {
    throw new Error(failureMessage(`\`${command} ${args.join(" ")}\``, res));
  }
}
