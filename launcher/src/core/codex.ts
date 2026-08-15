/**
 * Is there a newer Codex CLI to install? The pure half of the "Codex update
 * available" banner — `main/codex.ts` runs the two commands whose output this
 * reads, and nothing in here knows that a container exists.
 *
 * Codex is npm-installed into the Box image (box/Dockerfile) and, unlike Claude
 * Code, is deliberately NOT updated on every launch: `npm install -g` costs
 * ~15s whether or not anything changed, and Refresh on Launch is meant to be
 * free on a warm machine. So the launch only compares two version strings and
 * the Sandbox User decides whether to spend the download.
 */

/**
 * The version in a command's output. `codex --version` prints "codex-cli 0.9.1"
 * and `npm view @openai/codex version` prints "0.9.1", so both are read the same
 * way: the first dotted number in the text.
 *
 * Undefined when there is no such number, and that is this module's ENTIRE error
 * handling — a Box with no Codex in it, a registry the egress policy or the
 * network kept us from, a command that printed a usage banner instead. None of
 * them is a version, so none of them produces a banner.
 */
export function codexVersion(output: string): string | undefined {
  return /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/.exec(output)?.[1];
}

/**
 * Is `latest` a release the Box does not already have? Field by field as
 * NUMBERS, because the answer for 0.9.1 → 0.10.0 is yes and string order says
 * the opposite — which would leave a Sandbox User pinned to an old Codex with no
 * banner and nothing to click.
 *
 * A prerelease suffix is compared away with the rest of the tail: npm's `latest`
 * tag never points at one, so the only way to be running a prerelease is to have
 * installed it on purpose, and the safe answer for someone who did that is to
 * offer them nothing.
 */
export function isNewerVersion(installed: string, latest: string): boolean {
  const fields = (version: string) => version.split("-")[0]!.split(".").map(Number);
  const have = fields(installed);
  const want = fields(latest);
  for (let i = 0; i < 3; i++) {
    const [a, b] = [have[i] ?? 0, want[i] ?? 0];
    if (Number.isNaN(a) || Number.isNaN(b)) return false; // not a version we can rank
    if (a !== b) return b > a;
  }
  return false;
}

/**
 * The version to put in the banner, or undefined for "say nothing" — which is
 * every unhelpful outcome at once: either command failing, output holding no
 * version, or a registry that is level with (or behind) what is installed.
 */
export function codexUpdate(
  installedOutput: string,
  latestOutput: string,
): string | undefined {
  const installed = codexVersion(installedOutput);
  const latest = codexVersion(latestOutput);
  if (!installed || !latest) return undefined;
  return isNewerVersion(installed, latest) ? latest : undefined;
}
