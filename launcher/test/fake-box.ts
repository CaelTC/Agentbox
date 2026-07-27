import type { BoxExec, PipeStage } from "../src/main/box-exec";
import type { RunResult } from "../src/main/exec";

/**
 * A Box in a test's hand. `main/workspace.ts` takes its Box as an argument, so
 * every Workspace operation is assertable against this instead of a `vi.mock` of
 * the whole engine layer — the point of the seam (main/box-exec.ts).
 *
 * Its own file so that any test of anything built on `BoxExec` can reach it —
 * test/workspace.test.ts is the first — without a barrel or a cross-test import.
 */

export type Op =
  | "exec"
  | "tryExec"
  | "execAsRoot"
  | "writeFile"
  | "copyIn"
  | "copyOut"
  | "copyInStream"
  | "stopDetached";

/** One `copyInStream`: the whole payload that crosses into the Box. */
export interface StreamedIn {
  /** The producing command and its argv — `tar -c … -C <folder> --null -T -`. */
  readonly source: PipeStage;
  /** The Box-side directory the archive unpacks into. */
  readonly dir: string;
  /** The NUL-separated file list fed to that command's stdin. */
  readonly input: string;
}

export interface FakeBox extends BoxExec {
  /** Every operation performed, as `op arg arg…`, in order. */
  readonly calls: string[];
  /**
   * Import's payload, kept apart from `calls` because it is structure rather
   * than a line: the tar argv decides WHAT crosses (`importTarArgs`) and the
   * stdin decides WHICH FILES (`importTarInput`). Flattened into `calls` they
   * were unassertable, so swapping the tar'd directory or dropping `.git` from a
   * repo import passed every test.
   */
  readonly streams: StreamedIn[];
}

/**
 * A Box that answers with whatever `reply` returns — a string for stdout, an
 * Error to make that one operation fail, or a whole `RunResult` for the one
 * shape the other two cannot express: output AND a non-zero exit, which is what
 * `find` does when it stumbles over a file that vanished mid-walk.
 */
export type Reply = string | Error | RunResult;

export function fakeBox(reply: (op: Op, args: readonly string[]) => Reply = () => ""): FakeBox {
  const calls: string[] = [];
  const streams: StreamedIn[] = [];
  const answer = (op: Op, args: readonly string[]): string => {
    calls.push([op, ...args].join(" "));
    const replied = reply(op, args);
    if (replied instanceof Error) throw replied;
    return typeof replied === "string" ? replied : replied.stdout;
  };
  return {
    calls,
    streams,
    exec: async (argv) => answer("exec", argv),
    tryExec: async (argv) => {
      calls.push(["tryExec", ...argv].join(" "));
      const replied = reply("tryExec", argv);
      if (replied instanceof Error) return { code: 1, stdout: "", stderr: replied.message };
      return typeof replied === "string" ? { code: 0, stdout: replied, stderr: "" } : replied;
    },
    execAsRoot: async (argv) => void answer("execAsRoot", argv),
    writeFile: async (path, content) => void answer("writeFile", [path, content]),
    copyIn: async (hostPath, boxPath) => void answer("copyIn", [hostPath, boxPath]),
    copyOut: async (boxPath, hostPath) => void answer("copyOut", [boxPath, hostPath]),
    copyInStream: async (source, dir, input) => {
      // Recorded BEFORE `answer`, which throws when the reply is an Error: the
      // failure tests are about what happened to a stream that was attempted.
      streams.push({ source, dir, input });
      return void answer("copyInStream", [source.command, dir]);
    },
    stopDetached: () => void answer("stopDetached", []),
  };
}
