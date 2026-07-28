import { spawn } from "node:child_process";
import { BOX_CONTAINER, BOX_ROOT_PATH, ENGINE_CLI } from "../core/config";
import { failureMessage, run, spawnPath, type RunResult } from "./exec";

/**
 * The Box-exec seam: every invocation of the Engine CLI against the RUNNING Box
 * — exec, exec-as-root, copy in, copy out, stop — goes through this one object.
 * Nothing else builds `docker exec agentbox …` argv or prefixes a path with
 * `agentbox:`, with ONE named exception: `boxUpdateClaudeArgs` (core/box.ts),
 * which `main/session.ts` runs on every launch as root. It stays outside because
 * it is best-effort — every failure is one `false` — and because it carries its
 * own in-Box `timeout 180`, longer than this seam's deadline below. (The Box's
 * LIFECYCLE — build, run, start, rm — is not this module's either:
 * `main/session.ts` owns that, and reaches a Box that may not be up yet, which
 * is why those calls use `mustSucceed` directly.)
 *
 * Four decisions live here, and only here:
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
 * 3. A DEADLINE. Every `exec` into the Box is bounded (see BOX_EXEC_TIMEOUT_MS).
 *    Not the copies: `docker cp` of a multi-GB Import or Export is legitimately
 *    slow, and those genuinely can hold the Box Gate for minutes — which is
 *    correct, since a copy is exactly the thing nothing else may race.
 *
 * 4. THE PATH FIX. Everything routes through exec.ts's `run` / `spawnPath`, so
 *    a Launcher opened from Finder (minimal PATH, no `/opt/homebrew/bin`) can
 *    still find the Engine — `stopDetached` and `runPipe` included, both of
 *    which spawn for themselves. `stopDetached` used to spawn the Engine
 *    without it and die of ENOENT inside a bare `catch {}`, leaving the Box
 *    running after quit.
 *
 * `runPipe` lives at the foot of this file rather than in exec.ts: streaming a
 * tar into the Box is its only caller, so its two failure modes and the
 * normalisation of them (`copyInStream`) belong on one screen.
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

/**
 * How long an `exec` into the Box may take before it is killed and reported as
 * a failure. Generous, because it is a backstop and not a policy: nothing here
 * is meant to take two minutes, and a `docker exec` that does is wedged. The
 * gate is single-file, so an exec that never returns is not one dead operation
 * — it is every Box channel dead for the life of the Launcher, including the
 * Update Agentbox that would ship the fix.
 */
export const BOX_EXEC_TIMEOUT_MS = 120_000;

/** Every operation the Launcher performs against the running Box. */
export interface BoxExec {
  /**
   * Run argv in the Box as the sandbox user; resolve its stdout, throw on a
   * non-zero exit. `what` is how that failure is named to the Sandbox User —
   * pass it wherever "`docker exec agentbox df -kP …` failed" is not a sentence
   * anyone should have to read; the argv itself is the default.
   */
  exec(argv: readonly string[], what?: string): Promise<string>;
  /**
   * Run argv in the Box and resolve the raw result, including a non-zero exit —
   * a spawn that fails outright included, as `code: -1`. ONLY for calls where
   * "it failed" is a legitimate answer — every use is commented at the call site
   * with why ignoring the code is correct. A caller that means to fail, only in
   * better words, passes `what` to `exec` instead.
   */
  tryExec(argv: readonly string[]): Promise<RunResult>;
  /**
   * Run argv in the Box as root; throw on a non-zero exit, named by `what` as
   * `exec` is.
   *
   * Root is needed because `docker cp` SYNTHESISES the parent directories of a
   * streamed archive as root (tar emits no directory entries for them), so an
   * imported Project contains directories the sandbox user cannot chown or
   * unlink. Delete and the failed-import cleanup both hit exactly that.
   */
  execAsRoot(argv: readonly string[], what?: string): Promise<void>;
  /**
   * Write `content` to `path` inside the Box; throw if it did not land. Sent as
   * base64 so arbitrary content (a Project's friendly name, a seed prompt) never
   * meets a shell.
   */
  writeFile(path: string, content: string): Promise<void>;
  /** Copy one host path into the Box; throw on failure. Unbounded (decision 3). */
  copyIn(hostPath: string, boxPath: string): Promise<void>;
  /** Copy one Box path out to the host; throw on failure. Unbounded (decision 3). */
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

const boxFailure = (what: string, res: RunResult): Error => new Error(failureMessage(what, res));

const inBox = (argv: readonly string[]): string[] => ["exec", BOX_CONTAINER, ...argv];
// `-e PATH` also governs how the engine RESOLVES the bare command itself, so a
// root exec never looks in the sandbox-writable /usr/local/cargo/bin (see
// BOX_ROOT_PATH for the escalation this closes).
const inBoxAsRoot = (argv: readonly string[]): string[] => [
  "exec",
  "-u",
  "root",
  "-e",
  `PATH=${BOX_ROOT_PATH}`,
  BOX_CONTAINER,
  ...argv,
];

/**
 * Run engine argv, throwing `what` on any non-zero exit. `timeoutMs` is the
 * deadline every exec gets and the copies deliberately do not (decision 3).
 */
async function must(
  argv: readonly string[],
  what = describe(argv),
  timeoutMs?: number,
): Promise<string> {
  const res = await run(ENGINE_CLI, argv, undefined, timeoutMs);
  if (res.code !== 0) throw boxFailure(what, res);
  return res.stdout;
}

export const boxExec: BoxExec = {
  exec: (argv, what) => must(inBox(argv), what, BOX_EXEC_TIMEOUT_MS),

  tryExec: (argv) =>
    run(ENGINE_CLI, inBox(argv), undefined, BOX_EXEC_TIMEOUT_MS).catch((err: unknown) => ({
      // `run` REJECTS when the Engine binary cannot be spawned at all (ENOENT on
      // a Finder-launched PATH). Every caller here is tolerant by design and
      // reads `.code`, so a rejection would be the one outcome none of them
      // handle — it becomes the same "it failed" answer as a non-zero exit.
      code: -1,
      stdout: "",
      stderr: String(err),
    })),

  execAsRoot: async (argv, what) => void (await must(inBoxAsRoot(argv), what, BOX_EXEC_TIMEOUT_MS)),

  writeFile: async (path, content) => {
    const b64 = Buffer.from(content, "utf8").toString("base64");
    await must(
      inBox(sh('printf %s "$1" | base64 -d > "$2"', b64, path)),
      `Writing '${path}' inside the Box`,
      BOX_EXEC_TIMEOUT_MS,
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

/* ------------------------------------------------------------------------- *
 * `copyInStream`'s plumbing. Exported only so its exit-code precedence and its
 * two EPIPE directions can be asserted against real processes.
 * ------------------------------------------------------------------------- */

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
    // A write to a dead process's stdin raises EPIPE, and an 'error' with no
    // listener takes the whole Launcher down. Both directions can hit it: `b`
    // exiting before it has read the stream, and `a` exiting before it has read
    // `input` (a `tar` that dies on a bad -C). Either child's non-zero exit is
    // the real error; the stream error is noise on top of it.
    second.stdin.on("error", () => {});
    first.stdin.on("error", () => {});

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
    second.on("close", (code) => {
      secondCode = code ?? -1;
      // If `b` died before draining the stream, `a` is still writing into a
      // buffer nobody will read, and blocks forever once it fills — this
      // Promise would never settle, and the Import the user is watching would
      // spin indefinitely. Closing the read end hands `a` the SIGPIPE a real
      // shell pipeline would have. A no-op when `a` has already finished.
      first.stdout.destroy();
      settle();
    });

    first.stdin.end(input);
  });
}
