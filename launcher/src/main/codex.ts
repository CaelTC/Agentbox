import { boxUpdateCodexArgs } from "../core/box";
import { codexUpdate } from "../core/codex";
import { ENGINE_CLI } from "../core/config";
import { boxExec, type BoxExec } from "./box-exec";
import { failureMessage, run } from "./exec";

/**
 * The Codex CLI's update, which — unlike Claude Code's — is the Sandbox User's
 * to trigger (backlog: codex-update-notify). Its own module rather than two more
 * functions in `main/session.ts`, because between them they are one story with
 * one piece of state: the launch ASKS whether there is a newer Codex, the home
 * screen offers what the answer says, and pressing the button INSTALLS it and
 * makes the answer "nothing".
 *
 * Everything here is best effort in the strict sense — every way the check can
 * go wrong resolves to `undefined`, which is simply no banner. Only the install
 * throws, because that one someone is watching.
 */

/**
 * How long the install may take before the host gives up on it. Longer than the
 * in-Box `timeout 300` it carries, which is the real limit: this is the backstop
 * for a `docker exec` that never returns at all, and it runs holding the Box
 * Gate (see `updateClaudeCode`, which is bounded the same way for the same
 * reason).
 */
const CODEX_UPDATE_DEADLINE_MS = 360_000;

/**
 * The check's answer, memoized as the PROMISE rather than the value, which is
 * what makes one check serve two askers with no race between them. The launch
 * starts it (bootstrap.ts) and the home screen asks for it moments later; the
 * second caller joins the first one's `docker exec` instead of starting a second
 * — and, crucially, WAITS for it, so a home screen that renders while the check
 * is still running gets the real answer rather than "nothing yet".
 */
let checked: Promise<string | undefined> | undefined;

/**
 * The version of Codex waiting in the registry, or undefined when the Box has
 * the latest — or when we could not find out, which is the same thing to a
 * screen that has nothing to say either way.
 */
export function checkCodexUpdate(box: BoxExec = boxExec): Promise<string | undefined> {
  return (checked ??= readCodexUpdate(box));
}

/**
 * Forget the answer, so the next ask re-reads the Box. For the one event that
 * silently changes what is installed underneath us: a recreate drops the
 * container back to the Codex baked into the image (refresh-runner.ts).
 */
export function forgetCodexUpdate(): void {
  checked = undefined;
}

/**
 * Both halves of the comparison, through the Box-exec seam like every other
 * command against a running Box. `tryExec`, not `exec`: a Box with no Codex in
 * it, a registry we cannot reach, a container that went away mid-check — every
 * one of those is an ANSWER here ("no banner"), and none of them is worth a word
 * to the Sandbox User. Failed commands print to stderr, so their empty stdout
 * carries no version and `codexUpdate` says nothing.
 *
 * `npm view` runs IN the Box on purpose: the registry lookup then leaves by the
 * same route, under the same Egress Policy, as everything else Agentbox fetches
 * — and the host is not assumed to have npm on the PATH a Finder-launched app
 * inherits.
 */
async function readCodexUpdate(box: BoxExec): Promise<string | undefined> {
  const installed = await box.tryExec(["codex", "--version"]);
  const latest = await box.tryExec(["npm", "view", "@openai/codex", "version"]);
  return codexUpdate(installed.stdout, latest.stdout);
}

/**
 * Install the latest Codex in the Box — the banner's button, and the only thing
 * in Agentbox that runs `npm install -g` at run time. Resolves with the sentence
 * to show; THROWS on failure, because unlike the check there is someone waiting
 * on this one, and "nothing happened" is not an answer to a button.
 *
 * Outside the Box-exec seam for exactly the reasons `updateClaudeCode` is (see
 * main/box-exec.ts): it runs as root, and it carries its own in-Box `timeout`
 * that is longer than the seam's deadline.
 */
export async function updateCodex(): Promise<string> {
  const res = await run(
    ENGINE_CLI,
    boxUpdateCodexArgs(),
    undefined,
    CODEX_UPDATE_DEADLINE_MS,
    // `run` REJECTS when the Engine binary cannot be spawned at all; to the
    // Sandbox User that is the same failed update as a non-zero exit.
  ).catch((err: unknown) => ({ code: -1, stdout: "", stderr: String(err) }));

  if (res.code !== 0) throw new Error(failureMessage("Codex update", res));

  // Installed, so there is nothing left to offer: the banner's answer becomes
  // "nothing" without another round trip to the registry to prove it.
  checked = Promise.resolve(undefined);
  return "Codex is up to date.";
}
