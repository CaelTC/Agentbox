import { spawn } from "node:child_process";
import { BOX_CONTAINER, ENGINE_CLI } from "../core/config";
import { run, runPipe, spawnPath, type PipeStage, type RunResult } from "./exec";

/**
 * The Box-exec seam: every invocation of the Engine CLI against the RUNNING Box
 * — exec, exec-as-root, copy in, copy out, stop — goes through this one object.
 * Nothing else builds `docker exec claudebox …` argv or prefixes a path with
 * `claudebox:`. (The Box's LIFECYCLE — build, run, start, rm — is not this
 * module's: `main/session.ts` owns that, and reaches a Box that may not be up
 * yet, which is also why the session funnel still calls `mustSucceed` directly.)
 *
 * Three decisions live here, and only here:
 *
 * 1. FAILURE IS AN ERROR. Every operation throws on a non-zero exit. `tryExec`
 *    is the single marked exception, for the few calls where non-zero is an
 *    ANSWER (`test -e` on a Project that isn't there, `tmux kill-session` with
 *    no live session) rather than a failure. Before this seam existed six
 *    `run()` results were dropped on the floor, so a failed `docker cp` still
 *    reported "Uploaded 3 file(s)" to the Sandbox User.
 *
 * 2. QUOTING. Callers pass argv, or a script plus its values through `sh()` —
 *    never a hand-quoted `sh -c` string with a Box path spliced into it.
 *
 * 3. THE PATH FIX. Everything routes through exec.ts's `run` / `runPipe` /
 *    `spawnPath`, so a Launcher opened from Finder (minimal PATH, no
 *    `/opt/homebrew/bin`) can still find the Engine — `stopDetached` included,
 *    which used to spawn the Engine directly and die of ENOENT inside a bare
 *    `catch {}`, leaving the Box running after quit.
 *
 * The interface is the test surface: `main/workspace.ts` takes a `BoxExec`, so
 * its behaviour is asserted against one fake Box instead of by mocking the whole
 * of `./exec`.
 */

/**
 * Argv for a POSIX shell script inside the Box, with its values passed as
 * POSITIONAL PARAMETERS: `sh -c SCRIPT sh VALUE…` sets `$0` to `sh` and `$1`,
 * `$2`, … to the values, so the script reads them as `"$1"` and a path never
 * becomes part of the script text. That is why no caller quotes anything —
 * there is no interpolation to quote.
 */
export function sh(script: string, ...values: readonly string[]): readonly string[] {
  return ["sh", "-c", script, "sh", ...values];
}

/** Every operation the Launcher performs against the running Box. */
export interface BoxExec {
  /** Run argv in the Box as the sandbox user; resolve its stdout, throw on a non-zero exit. */
  exec(argv: readonly string[]): Promise<string>;
  /**
   * Run argv in the Box and resolve the raw result, including a non-zero exit.
   * ONLY for calls where "it failed" is a legitimate answer — every use is
   * commented at the call site with why ignoring the code is correct.
   */
  tryExec(argv: readonly string[]): Promise<RunResult>;
  /**
   * Run argv in the Box as root; throw on a non-zero exit.
   *
   * Root is needed because `docker cp` SYNTHESISES the parent directories of a
   * streamed archive as root (tar emits no directory entries for them), so an
   * imported Project contains directories the sandbox user cannot chown or
   * unlink. Delete and the failed-import cleanup both hit exactly that.
   */
  execAsRoot(argv: readonly string[]): Promise<void>;
  /**
   * Write `content` to `path` inside the Box; throw if it did not land. Sent as
   * base64 so arbitrary content (a Project's friendly name, a seed prompt) never
   * meets a shell.
   */
  writeFile(path: string, content: string): Promise<void>;
  /** Copy one host path into the Box; throw on failure. */
  copyIn(hostPath: string, boxPath: string): Promise<void>;
  /** Copy one Box path out to the host; throw on failure. */
  copyOut(boxPath: string, hostPath: string): Promise<void>;
  /**
   * Stream `source`'s stdout into `boxDir` as a tar archive (Project Import's
   * one round trip for thousands of files); throw on failure.
   */
  copyInStream(source: PipeStage, boxDir: string, input: string): Promise<void>;
  /**
   * Stop the Box, detached and unawaited — the Launcher-quit path, where there
   * is no longer anyone to report a failure to.
   */
  stopDetached(): void;
}

/** `docker …` as the user would read it back, with a long argv (base64) elided. */
function describe(argv: readonly string[]): string {
  const line = argv.join(" ");
  return `\`${ENGINE_CLI} ${line.length > 120 ? `${line.slice(0, 117)}…` : line}\``;
}

function boxFailure(what: string, res: RunResult): Error {
  const detail = res.stderr.trim() || res.stdout.trim() || "no output";
  return new Error(`${what} failed (exit ${res.code}): ${detail}`);
}

const inBox = (argv: readonly string[]): string[] => ["exec", BOX_CONTAINER, ...argv];
const inBoxAsRoot = (argv: readonly string[]): string[] => [
  "exec",
  "-u",
  "root",
  BOX_CONTAINER,
  ...argv,
];

/** Run engine argv, throwing `what` on any non-zero exit. */
async function must(argv: readonly string[], what = describe(argv)): Promise<string> {
  const res = await run(ENGINE_CLI, argv);
  if (res.code !== 0) throw boxFailure(what, res);
  return res.stdout;
}

export const boxExec: BoxExec = {
  exec: (argv) => must(inBox(argv)),

  tryExec: (argv) => run(ENGINE_CLI, inBox(argv)),

  execAsRoot: async (argv) => void (await must(inBoxAsRoot(argv))),

  writeFile: async (path, content) => {
    const b64 = Buffer.from(content, "utf8").toString("base64");
    await must(
      inBox(sh('printf %s "$1" | base64 -d > "$2"', b64, path)),
      `Writing '${path}' inside the Box`,
    );
  },

  copyIn: async (hostPath, boxPath) => {
    await must(["cp", hostPath, `${BOX_CONTAINER}:${boxPath}`]);
  },

  copyOut: async (boxPath, hostPath) => {
    await must(["cp", `${BOX_CONTAINER}:${boxPath}`, hostPath]);
  },

  copyInStream: async (source, boxDir, input) => {
    // `runPipe` has TWO failure modes: it REJECTS when a stage cannot be spawned
    // at all (no `tar`, no engine binary) and RESOLVES non-zero when a stage ran
    // and failed. Both are one failure to a caller, so the normalisation lives
    // here rather than being repeated at every call site.
    const res = await runPipe(
      source,
      { command: ENGINE_CLI, args: ["cp", "-", `${BOX_CONTAINER}:${boxDir}`] },
      input,
    ).catch((err: unknown) => ({ code: -1, stdout: "", stderr: String(err) }));
    if (res.code !== 0) throw boxFailure(`Streaming '${source.command}' into '${boxDir}'`, res);
  },

  stopDetached: () => {
    const child = spawn(ENGINE_CLI, ["stop", BOX_CONTAINER], {
      detached: true,
      stdio: "ignore",
      // The same PATH fix every other Engine call gets. Without it a Launcher
      // started from Finder spawns a bare `docker` that is not on PATH, and the
      // Box stayed up after quit — holding the Resource Cap.
      env: { ...process.env, PATH: spawnPath() },
    });
    // Node reports a failed spawn as an asynchronous 'error' event, never a
    // throw, and an EventEmitter with no 'error' listener rethrows — which here
    // means taking the main process down mid-quit. Nothing to do about it: the
    // Engine is already gone, so there is nothing left to stop.
    child.on("error", () => {});
    child.unref();
  },
};
