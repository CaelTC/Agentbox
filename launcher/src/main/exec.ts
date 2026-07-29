import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { ENGINE_PROFILE } from "../core/config";

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

/**
 * Pin every Engine call to the Box's own VM. The `docker` CLI talks to whatever
 * the CURRENT context points at — on a machine that also runs Docker Desktop
 * that is Docker Desktop, so the Box silently lands outside the Colima VM and
 * outside the Resource Cap (ADR 0001's boundary, unenforced). DOCKER_HOST
 * outranks the context, and Colima puts each profile's socket at a fixed path,
 * so pinning it here — the same choke point as the PATH fix — covers every
 * spawn at once. Absent VM ⇒ absent socket ⇒ commands fail closed instead of
 * quietly running against the wrong engine.
 *
 * Windows gets no pin: podman ignores DOCKER_HOST and targets its own machine.
 * ponytail: assumes the default $COLIMA_HOME (~/.colima); wire COLIMA_HOME
 * through here if anyone relocates it.
 */
export function engineEnv(
  platform: NodeJS.Platform = process.platform,
  home = homedir(),
): Readonly<Record<string, string>> {
  if (platform === "win32") return {};
  return { DOCKER_HOST: `unix://${home}/.colima/${ENGINE_PROFILE}/docker.sock` };
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
 * SIGTERM, then SIGKILL after a grace — to the child's whole process GROUP off
 * Windows, since a grandchild holding the stdout pipe keeps this promise open
 * (see `killGroup`) — and resolves like any other failure: non-zero, with the
 * deadline named in `stderr`, so callers need no new branch.
 *
 * The group is why the child is spawned `detached`: it is its own group leader,
 * so a signal to the Launcher's group no longer reaches it. Nothing here relies
 * on that — the child is never `unref`'d and this promise still awaits it.
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
      env: { ...process.env, ...env, PATH: spawnPath(), ...engineEnv() },
      detached: group,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));

    /**
     * The GROUP, not the child. This promise resolves on 'close', which waits
     * for the stdout/stderr pipes, and a HOST-side child leaves those pipes to
     * ITS children: signal the direct child alone and a grandchild lives on
     * holding the write end, so 'close' never arrives. Measured on the local
     * `sh -c` case in `test/exec.test.ts`: 9019ms to settle a 150ms deadline,
     * versus 165ms once the group is signalled.
     *
     * DEFENCE IN DEPTH, not the Box Gate's live failure mode. A `docker exec`
     * has no host-side grandchild — the shell it runs lives in the container
     * (under Colima, another VM kernel entirely), is no descendant of the
     * Launcher and holds no host fd; the only host holder of the pipe is the
     * `docker` CLI itself, which `child.kill` already ends. This covers host
     * helpers that do fork.
     *
     * Windows takes the direct-child path and KEEPS that hazard: `kill` there is
     * TerminateProcess on the one handle, so a forking host helper's children
     * survive holding the inherited pipes, and closing it needs a Job Object or
     * `taskkill /T /F`.
     */
    const killGroup = (signal: NodeJS.Signals) => {
      try {
        if (group && child.pid) {
          process.kill(-child.pid, signal);
          return;
        }
      } catch {
        // The group signal did not land (EPERM, or `-pid` no longer a live
        // group). The direct child below stays the floor.
      }
      try {
        child.kill(signal);
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
